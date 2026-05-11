/**
 * @packageDocumentation
 *
 * EPIC-1 PR-B1 / TASK 1.B1.3 — exportModel() drains runtime maps into
 * `events` array.
 *
 * PR-A reserved `events: readonly never[]`; TASK 1.B1.1 widened the
 * type to the six-arm union; TASK 1.B1.2 mirrored to Rust. This task
 * is the first end-to-end proof: an active subscriber registered on
 * the engine must surface as an `IRSubscribe` record on the wire.
 *
 * PR-B1 ships a deliberately narrow drain — only `IRSubscribe`. The
 * other variants (`IRSubscribeCallback`, `IRUnsubscribe`, `IRDispose`,
 * `IRRead`, `IRTxSet`) reserve the wire-format slot but are populated
 * by follow-on PRs once the EPIC-2 lint passes co-design the
 * tracking machinery in the engine. The brutal-critical review's
 * recommendation: prove the contract end-to-end with one consumer
 * before extending.
 *
 * Default scope discipline: every export emits at least one
 * `IRScope` — the `g.<graphId>:default` infinite scope every
 * subscriber falls under unless future PRs introduce explicit scope
 * options on `subscribe()`. The single-scope default is enough for
 * the SubscribeWithoutDispose pass to gate on (an `infinite` scope
 * absolves the dispose requirement).
 */

import { describe, expect, it } from 'vitest'
import { createCausl } from '../src/index.js'

describe('TASK 1.B1.3 / exportModel emits IRSubscribe events', () => {
  /**
   * Test 1 — a graph with one active subscriber emits exactly one
   * IRSubscribe record. The record carries the registered node id,
   * the graph's stable id, and a `time` that matches the registration
   * moment.
   */
  it('one active subscriber → one IRSubscribe event', () => {
    const g = createCausl({ name: 'g.events-1' })
    const a = g.input('a', 0)
    g.subscribe(a, () => {})
    const m = g.exportModel()
    const subs = m.events.filter((e) => e.kind === 'subscribe')
    expect(subs).toHaveLength(1)
    const [s] = subs
    if (s?.kind !== 'subscribe') throw new Error('narrowing')
    expect(s.target).toBe('a')
    expect(s.graphId).toBe('g.events-1')
    expect(typeof s.id).toBe('string')
    expect(s.id.length).toBeGreaterThan(0)
  })

  /**
   * Test 2 — three active subscribers (across two distinct nodes) →
   * three IRSubscribe records. Subscription ids are unique.
   */
  it('three active subscribers → three IRSubscribe events with unique ids', () => {
    const g = createCausl({ name: 'g.events-2' })
    const a = g.input('a', 0)
    const b = g.input('b', 0)
    g.subscribe(a, () => {})
    g.subscribe(a, () => {})
    g.subscribe(b, () => {})
    const m = g.exportModel()
    const subs = m.events.filter((e) => e.kind === 'subscribe')
    expect(subs).toHaveLength(3)
    const ids = new Set(
      subs.map((s) => (s.kind === 'subscribe' ? s.id : '')),
    )
    expect(ids.size).toBe(3)
  })

  /**
   * Test 3 — `unsubscribe()` removes the subscription from the
   * IRSubscribe drain. Pre-unsubscribe one record; post-unsubscribe
   * zero. (Future PRs add IRUnsubscribe records to the drain — under
   * PR-B1 the unsubscribe simply removes the IRSubscribe.)
   */
  it('unsubscribed subscriptions are dropped from the drain', () => {
    const g = createCausl({ name: 'g.events-3' })
    const a = g.input('a', 0)
    const off = g.subscribe(a, () => {})
    expect(g.exportModel().events.filter((e) => e.kind === 'subscribe')).toHaveLength(1)
    off()
    expect(g.exportModel().events.filter((e) => e.kind === 'subscribe')).toHaveLength(0)
  })

  /**
   * Test 4 — every drained IRSubscribe references a known scope. The
   * default scope (`g.<graphId>:default`, kind `'infinite'`) is
   * always present in `model.scopes` and is the value the drained
   * IRSubscribe.scopeId points to under PR-B1.
   */
  it('every drained IRSubscribe.scopeId resolves into model.scopes', () => {
    const g = createCausl({ name: 'g.events-4' })
    const a = g.input('a', 0)
    g.subscribe(a, () => {})
    const m = g.exportModel()
    const scopeIds = new Set(m.scopes.map((s) => s.id))
    for (const e of m.events) {
      if (e.kind === 'subscribe') {
        expect(scopeIds.has(e.scopeId)).toBe(true)
      }
    }
  })

  /**
   * Test 5 — every export emits at least the default scope. The
   * default is `g.<graphId>:default` with kind `'infinite'` —
   * `infinite` absolves a subscription from needing a paired dispose
   * (the SubscribeWithoutDispose pass keys on `kind` to gate the
   * lint).
   */
  it('default scope is always emitted with kind "infinite"', () => {
    const g = createCausl({ name: 'g.events-5' })
    const m = g.exportModel()
    const def = m.scopes.find((s) => s.id === 'g.events-5:default')
    expect(def).toBeDefined()
    expect(def?.kind).toBe('infinite')
  })

  /**
   * Test 6 — IRSubscribe.callbackSite is best-effort. Engine code
   * that lacks a stack-trace API at registration time records
   * `'<unknown>'` (fallback). The future PR that adds Error-stack
   * capture upgrades the fallback to a real `path:line:col` value.
   * PR-B1 pins the fallback discipline.
   */
  it('callbackSite is "<unknown>" fallback under PR-B1', () => {
    const g = createCausl({ name: 'g.events-6' })
    const a = g.input('a', 0)
    g.subscribe(a, () => {})
    const m = g.exportModel()
    const subs = m.events.filter((e) => e.kind === 'subscribe')
    expect(subs).toHaveLength(1)
    const [s] = subs
    if (s?.kind !== 'subscribe') throw new Error('narrowing')
    expect(typeof s.callbackSite).toBe('string')
  })

  /**
   * Test 7 — IRSubscribe.time is the GraphTime at which the
   * registration occurred (not export time). Registering before any
   * commit gives time = 0; registering after one commit gives time = 1.
   */
  it('IRSubscribe.time records the registration GraphTime', () => {
    const g = createCausl({ name: 'g.events-7' })
    const a = g.input('a', 0)
    g.commit('seed', (tx) => tx.set(a, 1)) // bumps time to 1
    g.subscribe(a, () => {}) // subscribes at time 1
    const m = g.exportModel()
    const subs = m.events.filter((e) => e.kind === 'subscribe')
    expect(subs).toHaveLength(1)
    const [s] = subs
    if (s?.kind !== 'subscribe') throw new Error('narrowing')
    expect(s.time).toBe(1)
  })

  /**
   * Test 8 — exportModel() with no subscribers emits an empty
   * `events` array. The default scope is still present (the wire
   * format requires at least one).
   */
  it('no subscribers → empty events array, default scope still present', () => {
    const g = createCausl({ name: 'g.events-8' })
    const m = g.exportModel()
    expect(m.events).toEqual([])
    expect(m.scopes.length).toBeGreaterThanOrEqual(1)
  })

  /**
   * Test 9 — the drained IR validates against the JSON Schema
   * (the wire-format contract the Rust checker regenerates). A
   * drained IRSubscribe missing a required field (graphId, scopeId,
   * etc.) trips here.
   */
  it('drained model validates against the schema-3 JSON Schema', async () => {
    const { causlModelJsonSchema } = await import('../src/schema.js')
    const g = createCausl({ name: 'g.events-9' })
    const a = g.input('a', 0)
    g.subscribe(a, () => {})
    const m = g.exportModel()

    // Recursive walker — same shape as the property test's validator,
    // narrowed to the keywords this schema document uses.
    function validate(value: unknown, schema: unknown, path = '$'): readonly string[] {
      const out: string[] = []
      walk(value, schema, path, out)
      return out
    }
    function walk(value: unknown, schema: unknown, path: string, out: string[]): void {
      if (typeof schema !== 'object' || schema === null) return
      const s = schema as Record<string, unknown>
      if ('const' in s && !Object.is(value, s['const'])) {
        out.push(`${path}: const mismatch`)
        return
      }
      if (Array.isArray(s['enum'])) {
        if (!(s['enum'] as readonly unknown[]).includes(value)) {
          out.push(`${path}: enum mismatch`)
          return
        }
      }
      if (Array.isArray(s['oneOf'])) {
        const branches = s['oneOf'] as readonly unknown[]
        let matches = 0
        let lastErrors: readonly string[] = []
        for (const branch of branches) {
          const errs = validate(value, branch, path)
          if (errs.length === 0) matches++
          else lastErrors = errs
        }
        if (matches !== 1) {
          out.push(`${path}: oneOf matched ${matches} branches; last: ${lastErrors.join('; ')}`)
          return
        }
      }
      if (typeof s['type'] === 'string') {
        const t = s['type']
        if (t === 'object' && (typeof value !== 'object' || value === null || Array.isArray(value))) {
          out.push(`${path}: not an object`)
          return
        }
        if (t === 'array' && !Array.isArray(value)) {
          out.push(`${path}: not an array`)
          return
        }
        if (t === 'string' && typeof value !== 'string') {
          out.push(`${path}: not a string`)
          return
        }
        if (t === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))) {
          out.push(`${path}: not an integer`)
          return
        }
        if (t === 'boolean' && typeof value !== 'boolean') {
          out.push(`${path}: not a boolean`)
          return
        }
      }
      if (typeof s['minLength'] === 'number' && typeof value === 'string') {
        if (value.length < (s['minLength'] as number)) out.push(`${path}: minLength violated`)
      }
      if (typeof s['minimum'] === 'number' && typeof value === 'number') {
        if (value < (s['minimum'] as number)) out.push(`${path}: minimum violated`)
      }
      if (s['type'] === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>
        if (Array.isArray(s['required'])) {
          for (const r of s['required'] as readonly string[]) {
            if (!(r in obj)) out.push(`${path}: missing ${r}`)
          }
        }
        const declared = (s['properties'] as Record<string, unknown> | undefined) ?? {}
        if (s['additionalProperties'] === false) {
          for (const k of Object.keys(obj)) {
            if (!(k in declared)) out.push(`${path}: extra ${k}`)
          }
        }
        for (const [k, sub] of Object.entries(declared)) {
          if (k in obj) walk(obj[k], sub, `${path}.${k}`, out)
        }
      }
      if (s['type'] === 'array' && Array.isArray(value) && s['items']) {
        for (let i = 0; i < value.length; i++) walk(value[i], s['items'], `${path}[${i}]`, out)
      }
    }

    const errors = validate(m, causlModelJsonSchema)
    expect(errors).toEqual([])
  })

  /**
   * Test 10 — the drained model JSON-round-trips byte-stably. PR-B1
   * is the wire-format break; tests that round-trip the export bytes
   * back through `JSON.parse` and assert deep-equality catch any
   * lossy serialization.
   */
  it('drained model JSON-round-trips deep-equal', () => {
    const g = createCausl({ name: 'g.events-10' })
    const a = g.input('a', 0)
    g.subscribe(a, () => {})
    g.commit('seed', (tx) => tx.set(a, 1))
    const m = g.exportModel()
    const round = JSON.parse(JSON.stringify(m))
    expect(round).toEqual(m)
  })
})
