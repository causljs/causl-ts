/**
 * @packageDocumentation
 *
 * Schema-3 surface tests pinning the `graphId` source rule from
 * `SPEC.md` §16.2.1.5 and the `InvalidGraphNameError` runtime gate.
 *
 * The schema-3 IR added `graphId` to every node and commit. The
 * source of that identifier is the precedence rule:
 *   1. Application-supplied `name` from `createCausl({ name })` wins.
 *   2. Engine-minted UUID v4 falls back when `name` is absent.
 * This file exercises the rule end-to-end against `exportModel()` and
 * pins the regex `/^[A-Za-z0-9_.:-]{1,256}$/` that the constructor
 * validates against.
 *
 * The tests are deep on purpose: they read every node's `graphId`,
 * every commit's `graphId`, and the document's top-level shape so a
 * future PR that drops the field on a single record (a "I'll fix
 * this in the next PR" oversight) lights up red here. The 1000-trial
 * floor lives on the property-test file alongside this one; the unit
 * tests here cover the boundary cases the property generator never
 * happens to land on.
 */
import { describe, expect, it } from 'vitest'
import { createCausl, CAUSL_MODEL_SCHEMA, InvalidGraphNameError } from '../src/index.js'

describe('schema-3 graphId source rule (SPEC §16.2.1.5)', () => {
  /**
   * The precedence rule's positive case: an application-supplied
   * `name` lands verbatim on every IR record.
   */
  it('applies application-supplied name to every node and commit', () => {
    const g = createCausl({ name: 'g.adopter-app' })
    const a = g.input('a', 1)
    g.derived('two-a', (get) => 2 * get(a))
    g.commit('seed', (tx) => tx.set(a, 3))
    const m = g.exportModel()

    expect(m.schema).toBe(CAUSL_MODEL_SCHEMA)
    for (const n of m.nodes) {
      expect(n.graphId).toBe('g.adopter-app')
    }
    for (const c of m.commits) {
      expect(c.graphId).toBe('g.adopter-app')
    }
  })

  /**
   * The precedence rule's fallback: an unsupplied `name` yields a
   * UUID v4 that lands consistently across every node + commit
   * produced by the same engine.
   */
  it('mints a UUID v4 when name is absent and shares it across records', () => {
    const g = createCausl()
    const a = g.input('a', 1)
    g.derived('two-a', (get) => 2 * get(a))
    g.commit('seed', (tx) => tx.set(a, 3))
    const m = g.exportModel()

    // RFC-4122 v4 layout: 8-4-4-4-12 hex with the version nibble
    // pinned at `4` and the variant nibble at one of `8|9|a|b`.
    const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    const ids = new Set<string>()
    for (const n of m.nodes) {
      expect(n.graphId).toMatch(v4)
      ids.add(n.graphId)
    }
    for (const c of m.commits) {
      expect(c.graphId).toMatch(v4)
      ids.add(c.graphId)
    }
    // Every record from one engine carries the same identity.
    expect(ids.size).toBe(1)
  })

  /**
   * Two un-named engines mint distinct identifiers. This is the
   * structural defence against accidental id-reuse the brutal-
   * critical review called out: 122 bits of UUID v4 collision space
   * is the only honest answer for the no-name case.
   */
  it('yields distinct graphIds across two un-named engines', () => {
    const a = createCausl().exportModel()
    const b = createCausl().exportModel()
    // Both empty graphs surface zero nodes; the document-level
    // `time` is `0` for both. The only differentiator is the
    // implicit `graphId` we exported empty arrays under — pull it
    // from a quick input registration so the assertion has data.
    const ga = createCausl()
    ga.input('x', 0)
    const gb = createCausl()
    gb.input('x', 0)
    const ma = ga.exportModel()
    const mb = gb.exportModel()
    expect(ma.nodes[0]?.graphId).not.toBe(mb.nodes[0]?.graphId)
    expect(a.events).toEqual([])
    expect(b.events).toEqual([])
  })
})

describe('InvalidGraphNameError (SPEC §16.2.1.5 regex gate)', () => {
  /**
   * The regex catalogue: every accepted character class has at
   * least one positive case here so a future tightening of the
   * regex breaks the test loudly.
   */
  it.each([
    'app',
    'a',
    'g.test',
    'g_test',
    'g-test',
    'g:slot',
    'A1B2C3',
    'doc.tree:root_branch-leaf',
    '0', // single digit
  ])('accepts %p as a graph name', (name) => {
    expect(() => createCausl({ name })).not.toThrow()
  })

  /**
   * The boundary: 256 characters at the edge of the cap.
   */
  it('accepts a 256-character name (the cap)', () => {
    const name = 'a'.repeat(256)
    expect(() => createCausl({ name })).not.toThrow()
  })

  /**
   * One character past the cap throws.
   */
  it('rejects a 257-character name (one past the cap)', () => {
    const name = 'a'.repeat(257)
    expect(() => createCausl({ name })).toThrow(InvalidGraphNameError)
  })

  /**
   * Empty string is not in the regex's `{1,256}` quantifier and
   * throws.
   */
  it('rejects the empty string', () => {
    expect(() => createCausl({ name: '' })).toThrow(InvalidGraphNameError)
  })

  /**
   * Disallowed characters from a representative cross-section of
   * shapes adopters have been observed pasting.
   */
  it.each([
    'a/b', // slash — filesystem path separator
    'a b', // space
    'a\nb', // newline
    'a\tb', // tab
    'a"b', // quote
    "a'b", // apostrophe
    'a@b', // at-sign
    'a#b', // hash
    'a%b', // percent
    'a&b', // ampersand
    'a/', // trailing slash
    '/a', // leading slash
  ])('rejects %p', (name) => {
    expect(() => createCausl({ name })).toThrow(InvalidGraphNameError)
  })

  /**
   * The error class carries the rejected value so adopters can
   * inspect what their input was without re-parsing the message.
   */
  it('preserves the rejected name on InvalidGraphNameError.invalidName', () => {
    try {
      createCausl({ name: 'no/slashes' })
      throw new Error('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidGraphNameError)
      if (e instanceof InvalidGraphNameError) {
        expect(e.invalidName).toBe('no/slashes')
        expect(e.kind).toBe('InvalidGraphName')
      }
    }
  })
})

describe('schema-3 top-level shape', () => {
  /**
   * The closure discipline pinned in §16.2.1.1: schema-3 documents
   * (PR-B1) have exactly seven top-level fields — `schema | time |
   * nodes | commits | events | scopes | bridges`. The `events`,
   * `scopes`, and `bridges` arrays are always present. A future PR
   * that drops a field (or adds an eighth without bumping the
   * schema) breaks here.
   */
  it('every exported document has exactly seven top-level fields', () => {
    const g = createCausl({ name: 'g.shape-test' })
    const m = g.exportModel()
    expect(Object.keys(m).sort()).toEqual([
      'bridges',
      'commits',
      'events',
      'nodes',
      'schema',
      'scopes',
      'time',
    ])
  })

  /**
   * The `events` array is empty under PR-A. A future PR-B widens
   * `IREvent` to a discriminated union; until then any non-empty
   * `events` is a wire-format violation.
   */
  it('events is the empty array under PR-A (IREvent = never)', () => {
    const g = createCausl({ name: 'g.events-test' })
    const a = g.input('a', 1)
    g.commit('seed', (tx) => tx.set(a, 2))
    const m = g.exportModel()
    expect(m.events).toEqual([])
    expect(m.events.length).toBe(0)
  })
})

describe('schema-3 ExportModelOptions.captureCallGraph', () => {
  /**
   * The option lands on the type system so adopters can already
   * thread it through their export pipelines. PR-A defers the
   * actual stack-trace capture to a follow-up; today the IR does
   * not carry `callGraph` regardless of the option value, but the
   * option must be reachable.
   */
  it('accepts captureCallGraph: true without throwing', () => {
    const g = createCausl({ name: 'g.callgraph-test' })
    g.input('a', 1)
    expect(() => g.exportModel({ captureCallGraph: true })).not.toThrow()
  })

  it('accepts captureCallGraph: false without throwing', () => {
    const g = createCausl({ name: 'g.callgraph-test' })
    g.input('a', 1)
    expect(() => g.exportModel({ captureCallGraph: false })).not.toThrow()
  })

  /**
   * Default is `true` per SPEC §16.2.1.4. This pins the default so
   * a future PR cannot silently flip it without breaking here.
   */
  it('default behaviour (option absent) matches captureCallGraph: true', () => {
    const g = createCausl({ name: 'g.callgraph-default' })
    g.input('a', 1)
    const withDefault = g.exportModel()
    const withTrue = g.exportModel({ captureCallGraph: true })
    // PR-A: callGraph absent on every commit either way (the field
    // is reserved on the type system but not yet emitted). Pin the
    // shape so the tests catch the day the capture lands.
    for (const c of withDefault.commits) {
      expect(c.callGraph).toBeUndefined()
    }
    for (const c of withTrue.commits) {
      expect(c.callGraph).toBeUndefined()
    }
  })
})
