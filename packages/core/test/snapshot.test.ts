/**
 * graph.snapshot() / graph.hydrate() round-trip tests (#129, #366, #378).
 *
 * `snapshot()` captures the current input set plus GraphTime as a
 * serialisable envelope (SSR transfer, persistence, time-travel).
 * Derived nodes are intentionally omitted — they are pure functions
 * of inputs by the denotational definition, so re-deriving them on
 * the destination is equivalent to transferring them, but cheaper
 * and immune to staleness. `hydrate()` routes the snapshot's input set
 * through the same Phase A–H commit pipeline that `commit()` drives:
 * `now` advances by exactly one tick (the §3 monotonicity invariant,
 * #366), a single `Commit` with `intent: 'hydrate'` and `originatedAt:
 * snap.time` is published, and commit-log consumers (devtools,
 * persistence layers, useCausl subscribers) wake up the same way
 * they would for any other engine state-change. The `intent: 'hydrate'`
 * distinction lets persistence layers skip replay-on-cold-start without
 * duplicating logic; `originatedAt` preserves the on-the-wire snapshot
 * label so devtools can answer "this commit replays a server snapshot
 * from t=N" without inspecting `intent` strings.
 *
 * The hydration design closes three race classes structurally: a
 * `schemaHash` capability check on the envelope rejects mismatched
 * id-sets via `HydrationSchemaError` (so a stale snapshot can't silently
 * tear engine state); the uniform "every state change is a commit"
 * contract guarantees subscribers actually wake on the hydrate event;
 * and the §3 monotonicity invariant holds across all commits, hydrate
 * included, so the `commitLog` is a totally-ordered Behavior (#366).
 * §5's "one mutation pipeline" contract holds: hydrate is a privileged
 * caller of `commit`'s pipeline, not a parallel one (#378).
 */

import { describe, expect, it } from 'vitest'
import {
  CommitInProgressError,
  createCausl,
  HydrationSchemaError,
  type Commit,
  type GraphSnapshot,
  type InputNode,
} from '../src/index.js'

describe('graph.snapshot() / hydrate()', () => {
  it('captures all input values + current GraphTime', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const b = g.input('b', 'hello')
    g.commit('bump', (tx) => tx.set(a, 5))
    const snap = g.snapshot()
    expect(snap.schema).toBe(1)
    expect(snap.time).toBe(1)
    expect(snap.inputs).toEqual({ a: 5, b: 'hello' })
  })

  it('omits derived nodes from the snapshot (recomputable from inputs by definition)', () => {
    const g = createCausl()
    const a = g.input('a', 2)
    g.derived('sq', (get) => get(a) * get(a))
    const snap = g.snapshot()
    expect(Object.keys(snap.inputs)).toEqual(['a'])
  })

  it('omits non-serializable values', () => {
    const g = createCausl()
    g.input('fn', () => 42)
    g.input('num', 7)
    const snap = g.snapshot()
    expect(snap.inputs).toEqual({ num: 7 })
  })

  it('hydrate applies snapshot inputs and advances time by exactly one tick (§3 monotonicity, #366)', () => {
    // Pre-#366: hydrate set `now = snap.time`, breaking the t₀<t₁<t₂<…
    // invariant when `snap.time` was lower than the live graph's `now`.
    // Post-#366: hydrate routes through the commit pipeline, advancing
    // `now` by exactly one tick regardless of `snap.time`. The on-the-
    // wire snapshot label is preserved as `Commit.originatedAt` so
    // devtools and persistence still see "this commit replays a server
    // snapshot from t=N" without inspecting `intent` strings.
    const g = createCausl()
    const a = g.input('a', 0)
    const b = g.input('b', 0)
    const before = g.now
    const snap: GraphSnapshot = { schema: 1, time: 42, inputs: { a: 99, b: 'x' } }
    g.hydrate(snap)
    expect(g.read(a)).toBe(99)
    expect(g.read(b)).toBe('x')
    // Monotonic advance: now = before + 1 (the §3 invariant), NOT 42.
    expect(g.now).toBe(before + 1)
    expect(g.now).toBeGreaterThan(before)
  })

  it('hydrate triggers derived recompute on next read', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    const sq = g.derived('sq', (get) => get(a) * get(a))
    expect(g.read(sq)).toBe(1)
    g.hydrate({ schema: 1, time: 5, inputs: { a: 6 } })
    expect(g.read(sq)).toBe(36)
  })

  it('hydrate notifies subscribers whose value changed', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    const seen: number[] = []
    g.subscribe(a, (v) => seen.push(v))
    seen.length = 0
    g.hydrate({ schema: 1, time: 1, inputs: { a: 99 } })
    expect(seen).toEqual([99])
  })

  it('round-trip: snapshot then hydrate on a fresh graph yields equal input state (#366 changes time semantics)', () => {
    const src = createCausl()
    const a = src.input('a', 1)
    src.input('b', 2)
    src.commit('bump', (tx) => tx.set(a, 100))
    const snap = src.snapshot()

    const dest = createCausl()
    dest.input('a', 0)
    dest.input('b', 0)
    dest.hydrate(snap)
    // Inputs and schemaHash round-trip identically; only `time` differs
    // because hydrate advances the dest clock by exactly one tick (§3
    // monotonicity, #366) rather than copying `snap.time`. The on-the-
    // wire snapshot label is preserved on the published Commit's
    // `originatedAt` field, not on the dest engine's `now`.
    const reSnap = dest.snapshot()
    expect(reSnap.inputs).toEqual(snap.inputs)
    expect(reSnap.schemaHash).toBe(snap.schemaHash)
    expect(reSnap.schema).toBe(snap.schema)
  })

  it('rejects unsupported schema versions', () => {
    const g = createCausl()
    expect(() =>
      g.hydrate({ schema: 99 as unknown as 1, time: 0, inputs: {} }),
    ).toThrow(/schema/)
  })

  it('rejects unsupported schema versions with HydrationSchemaError(reason="schema-version")', () => {
    const g = createCausl()
    try {
      g.hydrate({ schema: 99 as unknown as 1, time: 0, inputs: {} })
      throw new Error('expected hydrate to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(HydrationSchemaError)
      expect((err as HydrationSchemaError).reason).toBe('schema-version')
    }
  })

  it('snapshot envelope carries a deterministic schemaHash over the registered id-set', () => {
    const a = createCausl()
    a.input('a', 0)
    a.input('b', 0)
    const b = createCausl()
    // Different registration order, same id-set: hash should match.
    b.input('b', 1)
    b.input('a', 9)
    expect(a.snapshot().schemaHash).toBeDefined()
    expect(a.snapshot().schemaHash).toBe(b.snapshot().schemaHash)
  })

  it('rejects snapshots whose schemaHash does not match the live graph (P0)', () => {
    // Two graphs with materially different id-sets — snapshots from one
    // must not silently hydrate into the other; the brutal-critique P0.
    const src = createCausl()
    src.input('a', 1)
    src.input('b', 2)
    const snap = src.snapshot()

    const dest = createCausl()
    // Note the missing `b` — a stale snapshot would otherwise tear engine state.
    dest.input('a', 0)
    dest.input('c', 0)

    try {
      dest.hydrate(snap)
      throw new Error('expected hydrate to throw on schemaHash mismatch')
    } catch (err) {
      expect(err).toBeInstanceOf(HydrationSchemaError)
      expect((err as HydrationSchemaError).reason).toBe('schema-hash')
    }
  })

  it('hydrate emits a Commit with intent="hydrate" and originatedAt=snap.time to subscribeCommits (P0, #366, #378)', () => {
    // Closes the brutal-critique P0: commit-log subscribers (useCausl,
    // devtools, persistence) must observe the hydrate event uniformly with
    // every other engine state-change. Post-#366/#378, the commit's `time`
    // is `prev.now + 1` (monotonic), and the snapshot's recorded label is
    // preserved on `originatedAt` so devtools can still distinguish "this
    // commit replays a server snapshot from t=N" without parsing strings.
    const g = createCausl()
    g.input('a', 0)
    const before = g.now
    const seen: Commit[] = []
    g.subscribeCommits((c) => seen.push(c))

    g.hydrate({ schema: 1, time: 7, inputs: { a: 99 } })

    expect(seen).toHaveLength(1)
    const c = seen[0]!
    expect(c.intent).toBe('hydrate')
    // §3 monotonicity: the commit's time is `prev.now + 1`, not snap.time.
    expect(c.time).toBe(before + 1)
    // The on-the-wire snapshot label is preserved on `originatedAt`.
    expect(c.originatedAt).toBe(7)
    expect(c.changedNodes).toContain('a')
  })

  it('hydrate refuses re-entrant invocation from inside a commit observer', () => {
    // Mirrors the CommitInProgressError contract on `commit`: hydrate is a
    // privileged mutation, it does not nest, and a re-entrant call must
    // surface a typed error rather than silently corrupt engine state.
    const g = createCausl()
    const a = g.input('a', 0)
    let captured: unknown = null
    g.subscribeCommits(() => {
      try {
        g.hydrate({ schema: 1, time: 99, inputs: { a: 5 } })
      } catch (err) {
        captured = err
      }
    })
    g.commit('bump', (tx) => tx.set(a, 1))
    expect(captured).toBeInstanceOf(CommitInProgressError)
  })

  it('round-trip preserves inputs and schemaHash; time advances by exactly one tick post-#366', () => {
    // Re-affirms the input round-trip and schemaHash equality — guards
    // against silent rename of the field. Post-#366, the dest's `now`
    // is `prev.now + 1` after hydrate (monotonic), not `snap.time`, so
    // `dest.snapshot().time !== snap.time` in general; only the inputs
    // and schemaHash round-trip identically.
    const src = createCausl()
    const a = src.input('a', 1)
    src.input('b', 2)
    src.commit('bump', (tx) => tx.set(a, 100))
    const snap = src.snapshot()
    expect(snap.schemaHash).toBeDefined()

    const dest = createCausl()
    dest.input('a', 0)
    dest.input('b', 0)
    const before = dest.now
    dest.hydrate(snap)
    const after = dest.snapshot()
    expect(after.inputs).toEqual(snap.inputs)
    expect(after.schemaHash).toBe(snap.schemaHash)
    expect(after.schema).toBe(snap.schema)
    expect(dest.now).toBe(before + 1)
  })

  // ---- §3/§5 invariants pinned post-#366/#378 ----

  it('post-hydrate graph.now is strictly greater than pre-hydrate graph.now (#366 monotonicity)', () => {
    // The §3 invariant in test form. Pre-#366, hydrate could drag `now`
    // backward when `snap.time < graph.now`; post-#366, hydrate routes
    // through commitInternal which advances `now` by exactly one tick.
    const g = createCausl()
    const a = g.input('a', 0)
    g.commit('one', (tx) => tx.set(a, 1))
    g.commit('two', (tx) => tx.set(a, 2))
    const before = g.now
    expect(before).toBe(2)
    // Snapshot whose `time` field is *less than* the live graph's now —
    // pre-fix this would have set `g.now = 0`, breaking monotonicity.
    g.hydrate({ schema: 1, time: 0, inputs: { a: 99 } })
    expect(g.now).toBeGreaterThan(before)
    expect(g.now).toBe(before + 1)
  })

  it('commitLog ordering is monotonic across mixed commit and hydrate calls (#366)', () => {
    // The §11 promise: the commit log is a `Behavior [Commit]` whose
    // `time` field totally orders the stream. A hydrate that jumped
    // `now` backward used to put a row with smaller `time` after rows
    // with larger `time`, breaking that ordering. Post-#366, every
    // adjacent pair satisfies `entries[i].time < entries[i+1].time`.
    // Explicit cap: SPEC §5.1 Amendment 2 (#716) flipped
    // `commitHistoryCap` default to 0; this test reads `commitLog`
    // entries so it must opt into retention.
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    const a = g.input('a', 0)
    g.commit('one', (tx) => tx.set(a, 1))
    g.commit('two', (tx) => tx.set(a, 2))
    g.hydrate({ schema: 1, time: 0, inputs: { a: 99 } })
    g.commit('three', (tx) => tx.set(a, 3))

    const log = g.read(g.commitLog)
    for (let i = 1; i < log.length; i++) {
      expect(log[i]!.time).toBeGreaterThan(log[i - 1]!.time)
    }
    // The hydrate row carries the on-the-wire label as `originatedAt`.
    const hydrateRow = log.find((c) => c.intent === 'hydrate')
    expect(hydrateRow).toBeDefined()
    expect(hydrateRow!.originatedAt).toBe(0)
  })

  it('hydrate fires per-node subscribers whose value changed (§5 commit pipeline, #378)', () => {
    // Pre-#378, hydrate had its own subscriber-dispatch loop parallel to
    // commit's. Post-#378, hydrate routes through commitInternal so the
    // §5 single-pipeline contract holds: subscribers fire from the same
    // Phase G loop that `commit` drives. Pinned here so a future refactor
    // that re-introduces a parallel pipeline is caught immediately.
    const g = createCausl()
    const a = g.input('a', 0)
    const seen: number[] = []
    g.subscribe(a as InputNode<number>, (v) => seen.push(v))
    seen.length = 0 // drop initial sync notification
    g.hydrate({ schema: 1, time: 50, inputs: { a: 99 } })
    expect(seen).toEqual([99])
  })

  it('commitLog records the hydrate entry with intent="hydrate" and originatedAt (§5, #378)', () => {
    // The §11 commit-log promise extended to hydrate: a hydration is a
    // first-class entry in the bounded log, observable through the same
    // `read(commitLog)` and `subscribe(commitLog, …)` API as any other
    // commit. Pinned here so a future refactor that skips Phase F for
    // hydrate is caught immediately.
    // Explicit cap: SPEC §5.1 Amendment 2 (#716) flipped
    // `commitHistoryCap` default to 0; the cap=0 path skips Phase F
    // (the bounded-log append) so opt-in retention is required to
    // observe the hydrate row in the log.
    const g = createCausl({ commitHistoryCap: 1000, snapshotRetentionCap: 50 })
    g.input('a', 0)
    g.hydrate({ schema: 1, time: 12, inputs: { a: 99 } })
    const log = g.read(g.commitLog)
    expect(log).toHaveLength(1)
    expect(log[0]!.intent).toBe('hydrate')
    expect(log[0]!.originatedAt).toBe(12)
    expect(log[0]!.changedNodes).toContain('a')
  })

  it('HydrationSchemaError is thrown BEFORE any commit is recorded (#378 atomicity)', () => {
    // The schema gates run before the commit pipeline is entered, so a
    // rejected hydrate leaves the engine state byte-identical to pre-call:
    // `now` unchanged, `commitLog` untouched, no subscriber fires. This
    // is the structural-rejection arm of the hydration race class — a
    // mismatched snapshot surfaces as a typed error, not a half-applied
    // engine state.
    const g = createCausl()
    const a = g.input('a', 7)
    g.commit('seed', (tx) => tx.set(a, 11))
    const beforeNow = g.now
    const beforeLog = g.read(g.commitLog).slice()
    const beforeValue = g.read(a)
    const seen: Commit[] = []
    g.subscribeCommits((c) => seen.push(c))
    seen.length = 0

    expect(() =>
      g.hydrate({ schema: 99 as unknown as 1, time: 0, inputs: { a: 999 } }),
    ).toThrow(HydrationSchemaError)

    expect(g.now).toBe(beforeNow)
    expect(g.read(g.commitLog)).toEqual(beforeLog)
    expect(g.read(a)).toBe(beforeValue)
    expect(seen).toEqual([])
  })

  it('regular commit() records carry no originatedAt (the field is hydrate-specific)', () => {
    // Capability discipline: `originatedAt` is the hydrate-only metadata
    // field; regular commits omit it so a consumer branching on
    // `c.originatedAt !== undefined` reliably distinguishes the two.
    const g = createCausl()
    const a = g.input('a', 0)
    const c = g.commit('bump', (tx) => tx.set(a, 1))
    expect(c.originatedAt).toBeUndefined()
  })
})
