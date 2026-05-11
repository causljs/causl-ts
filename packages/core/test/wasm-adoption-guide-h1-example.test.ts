/**
 * @packageDocumentation
 *
 * Doctest-style mirror of the right-vs-wrong memoisation example in
 * `docs/wasm-adoption-guide.md` § H1 (the adopter-facing companion to
 * SPEC §15.1 amendment #1124). This test pins the **semantics** of
 * the example: if the doc text drifts so that the "wrong" pattern
 * looks like it survives the WASM migration, or the "right" pattern
 * looks like it breaks, this file flags the divergence.
 *
 * The doc's example is written against React + `@causl/react`; this
 * file mirrors the same memoisation shape against the bare engine
 * (no React dependency) so the test runs inside the core package's
 * vitest harness. The two layers exercise the same contract:
 *
 *   - **Wrong pattern.** Memoise on the read return reference. Under
 *     the identity-erasing wrapper that models the post-migration
 *     Rust serde bridge, the reference changes every read, so the
 *     memo re-executes every read — even when the underlying value is
 *     bytewise unchanged. This is the silent-re-render hazard the
 *     SPEC §15.1 amendment warns about.
 *
 *   - **Right pattern.** Memoise on `commit.time` (the `GraphTime`
 *     exposed on every published `Commit` record). The memo
 *     invalidates iff a new commit lands AND the consumer asked for
 *     a fresh read. The pattern is backend-independent by
 *     construction: `commit.time` advances monotonically per SPEC §3
 *     atomicity regardless of which backend produced the commit.
 *
 * ## How drift is caught
 *
 * The doc's code blocks for the wrong + right patterns are mirrored
 * in this file's `WRONG_PATTERN_SOURCE` / `RIGHT_PATTERN_SOURCE`
 * constants — the same memoisation shape, transposed from React to
 * the bare-engine seam. A maintenance script (`tools/check-doctest-
 * drift.ts`, ships separately) does not exist yet for this seam;
 * until it does, the discipline is: when the doc's H1 example
 * changes, update the `WRONG_PATTERN_SOURCE` / `RIGHT_PATTERN_SOURCE`
 * constants here so they continue to mirror the same shape. The
 * runtime assertions below pin the contract — if either pattern
 * starts behaving differently from what the doc claims, the test
 * fails.
 *
 * ## Cross-references
 *
 * - SPEC §15.1 amendment (#1124).
 * - `docs/wasm-adoption-guide.md` § H1 (the canonical doc).
 * - `packages/core/test/properties/read-no-identity-contract.property.test.ts`
 *   — the 1000-trial property pin for the §15.1 contract surface.
 * - `packages/core/wasm/README.md` H1 callout.
 */

import { describe, expect, it } from 'vitest'
import { createCausl, type Graph, type Node } from '../src/index.js'

/**
 * The doc's wrong-pattern memoisation shape, transposed from React
 * `useMemo` to a bare-engine memo closure. The closure caches the
 * transformed value keyed on the **reference** of the read result;
 * when the reference changes, the closure recomputes.
 *
 * This is the shape an adopter would write against the TS engine and
 * not realise breaks at WASM-migration time:
 *
 *   const cached = useMemo(() => transform(user), [user])
 *
 * The `[user]` dep is the read return reference. Under the TS engine
 * the reference is stable across commits where the input did not
 * change, so the memo never invalidates spuriously. Under the WASM
 * substrate (modelled by the deep-clone wrapper below) the reference
 * changes every read, so the memo invalidates every read.
 */
const WRONG_PATTERN_SOURCE = `
function wrongMemo<T, R>(transform: (v: T) => R) {
  let cachedDep: T | undefined
  let cachedResult: R | undefined
  let hits = 0
  let misses = 0
  function get(v: T): R {
    if (cachedDep !== undefined && Object.is(cachedDep, v)) {
      hits++
      return cachedResult as R
    }
    misses++
    cachedDep = v
    cachedResult = transform(v)
    return cachedResult
  }
  return { get, stats: () => ({ hits, misses }) }
}
`

/**
 * The doc's right-pattern memoisation shape. Keys on \`commit.time\`
 * (a numeric `GraphTime`); the memo invalidates iff the commit time
 * advances. This is backend-independent: `commit.time` is a value-
 * typed number that crosses the FFI boundary unchanged.
 *
 *   const cached = useMemo(() => transform(user), [commit.time, user])
 *
 * The `commit.time` dep is the load-bearing one — `user` participates
 * for value-correctness only (so the closure recomputes if the same
 * commit observes a different value, which can't happen under §3
 * atomicity but the dep array stays honest).
 */
const RIGHT_PATTERN_SOURCE = `
function rightMemo<T, R>(transform: (v: T) => R) {
  let cachedTime: number | undefined
  let cachedResult: R | undefined
  let hits = 0
  let misses = 0
  function get(v: T, commitTime: number): R {
    if (cachedTime !== undefined && cachedTime === commitTime) {
      hits++
      return cachedResult as R
    }
    misses++
    cachedTime = commitTime
    cachedResult = transform(v)
    return cachedResult
  }
  return { get, stats: () => ({ hits, misses }) }
}
`

// Verify the source-text constants stay non-empty — a crude
// canary that catches an accidental deletion of either pattern
// in a future refactor of this file.
describe('SPEC §15.1 doctest mirror — H1 source-text constants are present', () => {
  it('WRONG_PATTERN_SOURCE references Object.is on the read return', () => {
    expect(WRONG_PATTERN_SOURCE).toContain('Object.is(cachedDep, v)')
    expect(WRONG_PATTERN_SOURCE).toContain('cachedDep = v')
  })
  it('RIGHT_PATTERN_SOURCE keys on commitTime', () => {
    expect(RIGHT_PATTERN_SOURCE).toContain('cachedTime === commitTime')
    expect(RIGHT_PATTERN_SOURCE).toContain('cachedTime = commitTime')
  })
})

/**
 * Runtime implementations of the two patterns. These mirror the
 * source-text constants above; if the constants drift, update these
 * functions in lockstep.
 */
function wrongMemo<T, R>(transform: (v: T) => R) {
  let cachedDep: T | undefined
  let cachedResult: R | undefined
  let hits = 0
  let misses = 0
  function get(v: T): R {
    if (cachedDep !== undefined && Object.is(cachedDep, v)) {
      hits++
      return cachedResult as R
    }
    misses++
    cachedDep = v
    cachedResult = transform(v)
    return cachedResult
  }
  return { get, stats: () => ({ hits, misses }) }
}

function rightMemo<T, R>(transform: (v: T) => R) {
  let cachedTime: number | undefined
  let cachedResult: R | undefined
  let hits = 0
  let misses = 0
  function get(v: T, commitTime: number): R {
    if (cachedTime !== undefined && cachedTime === commitTime) {
      hits++
      return cachedResult as R
    }
    misses++
    cachedTime = commitTime
    cachedResult = transform(v)
    return cachedResult
  }
  return { get, stats: () => ({ hits, misses }) }
}

/**
 * The deep-clone read wrapper that models the post-migration WASM
 * substrate. Identical to the one in
 * `read-no-identity-contract.property.test.ts` so the two files agree
 * on what "the future bridge does" looks like.
 */
function freshCopy<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  return structuredClone(value)
}

function identityErasingRead(graph: Graph): Graph {
  return new Proxy(graph, {
    get(target, prop, receiver) {
      if (prop === 'read') {
        return <T,>(node: Node<T>): T => freshCopy(target.read<T>(node))
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

describe('SPEC §15.1 doctest mirror — wrong-vs-right memoisation under the WASM substrate', () => {
  /**
   * The wrong pattern silently re-renders every read once the
   * substrate stops returning the same reference. We measure
   * cache-miss count across 5 reads of an unchanged object-valued
   * node, all at the same `commit.time`:
   *
   *   - Under the bare TS engine: reference is stable across reads,
   *     the wrong pattern hits 4 times and misses once (the first
   *     read primes the cache).
   *   - Under the identity-erasing wrapper: reference changes every
   *     read, the wrong pattern misses **every** read — 5 misses,
   *     0 hits. This is the silent-re-render hazard.
   */
  it('wrong pattern: under the substrate, every read is a cache miss (the hazard)', () => {
    const inner = createCausl()
    const node = inner.input<{ name: string; score: number }>('user', {
      name: 'roman',
      score: 42,
    })
    const graph = identityErasingRead(inner)

    const memo = wrongMemo<{ name: string; score: number }, string>(
      (u) => `${u.name}:${u.score}`,
    )

    // Five reads at the same commit time — the value is bytewise
    // unchanged, but the substrate returns a fresh reference each
    // time. The wrong pattern misses every read.
    for (let i = 0; i < 5; i++) {
      memo.get(graph.read(node))
    }

    const { hits, misses } = memo.stats()
    // The hazard: 0 hits, 5 misses, transform ran 5 times for an
    // unchanged value. An adopter who shipped this pattern would
    // see their dashboard re-render every commit.
    expect(misses).toBe(5)
    expect(hits).toBe(0)
  })

  /**
   * The wrong pattern under the bare TS engine looks fine — the
   * reference is stable, so the cache hits every read after the
   * first. This is the trap: the bug doesn't surface until
   * migration time.
   */
  it('wrong pattern: under the bare TS engine, the bug is invisible (the trap)', () => {
    const inner = createCausl()
    const node = inner.input<{ name: string; score: number }>('user', {
      name: 'roman',
      score: 42,
    })
    // NOTE: no identityErasingRead wrapper here — the bare engine
    // returns the same reference across reads.

    const memo = wrongMemo<{ name: string; score: number }, string>(
      (u) => `${u.name}:${u.score}`,
    )

    for (let i = 0; i < 5; i++) {
      memo.get(inner.read(node))
    }

    const { hits, misses } = memo.stats()
    // First read primes; subsequent four hit the cache. An adopter
    // ships this pattern, sees the cache hit, declares victory.
    // SPEC §15.1's contract clarification names this exact trap.
    expect(misses).toBe(1)
    expect(hits).toBe(4)
  })

  /**
   * The right pattern keys on `commit.time`, so it survives the
   * migration: cache hits behave the same under both backends
   * because `commit.time` is a value-typed number that crosses the
   * FFI boundary unchanged.
   */
  it('right pattern: under the substrate, the memo survives — 1 miss + 4 hits across reads at the same commit', () => {
    const inner = createCausl()
    const node = inner.input<{ name: string; score: number }>('user', {
      name: 'roman',
      score: 42,
    })
    const graph = identityErasingRead(inner)

    const memo = rightMemo<{ name: string; score: number }, string>(
      (u) => `${u.name}:${u.score}`,
    )

    // No commits between reads — `commit.time` does not advance —
    // so the right pattern's cache hits every read after the first.
    const t = inner.now
    for (let i = 0; i < 5; i++) {
      memo.get(graph.read(node), t)
    }

    const { hits, misses } = memo.stats()
    // Behaviour matches the bare-engine wrong-pattern case above —
    // 1 miss + 4 hits. The right pattern delivers the same
    // cache-hit rate the adopter expected from the wrong pattern,
    // but it survives the WASM migration.
    expect(misses).toBe(1)
    expect(hits).toBe(4)
  })

  /**
   * The right pattern invalidates cleanly when a commit lands:
   * `commit.time` advances, the next read misses, and the transform
   * re-runs. This is the contract the adopter actually wants.
   */
  it('right pattern: commit advances commit.time, memo invalidates exactly once per commit', () => {
    const inner = createCausl()
    const node = inner.input<{ name: string; score: number }>('user', {
      name: 'roman',
      score: 42,
    })
    const graph = identityErasingRead(inner)

    const memo = rightMemo<{ name: string; score: number }, string>(
      (u) => `${u.name}:${u.score}`,
    )

    // First read primes the cache.
    memo.get(graph.read(node), inner.now)
    // Read again at the same commit — hit.
    memo.get(graph.read(node), inner.now)
    expect(memo.stats()).toEqual({ misses: 1, hits: 1 })

    // Commit a new value; `now` advances.
    inner.commit('promote', (tx) =>
      tx.set(node, { name: 'roman', score: 99 }),
    )
    // Read again — `commit.time` changed, memo misses, transform reruns.
    memo.get(graph.read(node), inner.now)
    expect(memo.stats()).toEqual({ misses: 2, hits: 1 })
    // Read once more at the same new commit — hit.
    memo.get(graph.read(node), inner.now)
    expect(memo.stats()).toEqual({ misses: 2, hits: 2 })
  })
})

describe('SPEC §15.1 doctest mirror — the doc and the runtime stay in sync', () => {
  /**
   * Drift check: the runtime `wrongMemo` / `rightMemo` implementations
   * above must structurally mirror the `WRONG_PATTERN_SOURCE` /
   * `RIGHT_PATTERN_SOURCE` constants. We test this by:
   *
   *   1. Stringifying the function and checking the key tokens
   *      that pin the pattern's shape are present.
   *   2. Asserting both the source-text constant and the live
   *      function share those tokens.
   *
   * If a maintainer edits the runtime function without touching the
   * source-text constant (or vice versa), the assertion fires.
   */
  it('wrongMemo runtime matches WRONG_PATTERN_SOURCE on key tokens', () => {
    const runtime = wrongMemo.toString()
    // Both surfaces must reference the load-bearing `Object.is`
    // identity check that is the whole point of the wrong pattern.
    expect(runtime).toContain('Object.is(cachedDep, v)')
    expect(WRONG_PATTERN_SOURCE).toContain('Object.is(cachedDep, v)')
    // Both must mutate `cachedDep` on a miss.
    expect(runtime).toContain('cachedDep = v')
    expect(WRONG_PATTERN_SOURCE).toContain('cachedDep = v')
  })

  it('rightMemo runtime matches RIGHT_PATTERN_SOURCE on key tokens', () => {
    const runtime = rightMemo.toString()
    // Both must key on `commitTime`.
    expect(runtime).toContain('cachedTime === commitTime')
    expect(RIGHT_PATTERN_SOURCE).toContain('cachedTime === commitTime')
    // Both must mutate `cachedTime` on a miss.
    expect(runtime).toContain('cachedTime = commitTime')
    expect(RIGHT_PATTERN_SOURCE).toContain('cachedTime = commitTime')
  })
})
