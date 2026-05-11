/**
 * @packageDocumentation
 *
 * Two-primitive IR discipline (#359, #368). Pins the §4 commitment
 * at the IR boundary: every node in `CauslModel.nodes` has
 * `kind` exactly `'input'` or `'derived'`, the top-level shape
 * carries no `resources` / `conflicts` / `msgs` regions, and a
 * hand-rolled IR document with an unknown `kind` is rejected by
 * the JSON Schema's structural contract (the same schema the Rust
 * checker mirrors on the wire).
 *
 * The previous version of this file pinned the IR-extension surface
 * area introduced under EPIC #282 sub-issue #286: optional
 * `resources`, `conflicts`, and `msgs` arrays alongside `IRResource`,
 * `IRConflict`, `IRMsg` discriminated unions. That surface was the
 * eleven-`NodeKind` taxonomy §4 spent its budget collapsing — it
 * shipped as a wire format (the JSON Schema named five `kind`
 * constants) before any engine writer populated it, and a downstream
 * consumer (Rust checker, generated bindings, schema-derived types
 * in third-party tooling) reading the schema would learn "causl
 * has five node kinds" by the time the engine got around to telling
 * the truth. #359 retired the surface; this file now pins the
 * retirement.
 */

import { describe, it, expect } from 'vitest'
import {
  createCausl,
  CAUSL_MODEL_SCHEMA,
  causlModelJsonSchema,
  type CauslModel,
} from '../src/index.js'

/**
 * Closed set of `kind` constants the v2 schema admits inside
 * `nodes[*]`. Derived from the `oneOf` arms in the JSON Schema so
 * the literal stays in lock-step with the published contract — if a
 * future PR widens the schema, the array on this side widens too,
 * and the assertions below catch the drift.
 */
const ADMITTED_NODE_KINDS = causlModelJsonSchema.properties.nodes.items.oneOf.map(
  (arm) => arm.properties.kind.const,
)

describe('IR two-primitive discipline (§4 / #359 / #368)', () => {
  /**
   * Schema version is the wire-format invariant the Rust checker
   * matches against its compiled-in constant. #359 collapsed the IR
   * back to two primitives — a wire-format break — so the version
   * bumps to 2 and the JSON Schema's `$id` follows.
   */
  describe('schema-version contract', () => {
    /**
     * The exported version constant is the single source of truth.
     */
    it('CAUSL_MODEL_SCHEMA is at 3 after the EPIC-1 PR-A schema bump', () => {
      // PR-A bumped 2 → 3 to land `graphId` per node + commit, the
      // optional `IRCallGraph` annotation slot on `IRCommit`, and the
      // forward-compat `events: readonly never[]` field on
      // `CauslModel`. The constant is the single source of truth;
      // every Rust-side `causl-check` build pins to the same value.
      expect(CAUSL_MODEL_SCHEMA).toBe(3)
    })

    /**
     * The runtime export carries the same literal as the type.
     */
    it('exportModel().schema matches the constant', () => {
      const g = createCausl()
      expect(g.exportModel().schema).toBe(CAUSL_MODEL_SCHEMA)
    })

    /**
     * The JSON Schema `$id` is versioned alongside `schema`.
     */
    it('JSON Schema $id is the v3 identifier', () => {
      expect(causlModelJsonSchema.$id).toContain('causl-model-v3')
    })
  })

  /**
   * Closed shape — `CauslModel` carries `schema | time | nodes |
   * commits | events | scopes | bridges` and nothing else. No
   * `resources`, no `conflicts`, no `msgs`. Adapter packages that need
   * richer state ship a sibling document; they do not extend
   * `CauslModel`.
   */
  describe('CauslModel shape is closed at seven fields', () => {
    /**
     * exportModel() returns exactly the seven declared keys.
     */
    it('exportModel() returns exactly schema | time | nodes | commits | events | scopes | bridges', () => {
      const g = createCausl()
      const model = g.exportModel()
      // Schema 3 added `events`, `scopes`, and `bridges` (PR-B1).
      expect(Object.keys(model).sort()).toEqual([
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
     * The same shape holds after registrations and commits.
     */
    it('exportModel() carries no extra fields after registrations and commits', () => {
      const g = createCausl()
      const a = g.input('a', 1)
      g.derived<number>('b', (get) => get(a) + 1)
      g.commit('seed', (tx) => tx.set(a, 5))
      const model = g.exportModel()
      expect(Object.keys(model).sort()).toEqual([
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
     * The JSON Schema's top-level `additionalProperties: false` is
     * the structural boundary the Rust checker enforces — any field
     * past the seven schema-3 keys is refused on the wire. Pinning
     * it here catches a future PR that loosens the gate without
     * going through the §4 review.
     */
    it('JSON Schema closes the top level via additionalProperties: false', () => {
      expect(causlModelJsonSchema.additionalProperties).toBe(false)
      expect(causlModelJsonSchema.required).toEqual([
        'schema',
        'time',
        'nodes',
        'commits',
        'events',
        'scopes',
        'bridges',
      ])
      expect(Object.keys(causlModelJsonSchema.properties).sort()).toEqual([
        'bridges',
        'commits',
        'events',
        'nodes',
        'schema',
        'scopes',
        'time',
      ])
    })
  })

  /**
   * Every emitted node has `kind` exactly `'input'` or `'derived'`.
   * The §4 commitment is the runtime universe, and the IR mirrors
   * it. A test that walks the emitted nodes and asserts the closed
   * tag-set is the regression net against silent re-introduction of
   * a third arm.
   */
  describe('every emitted node uses kind in {input, derived}', () => {
    /**
     * Empty graph: zero nodes is trivially in the set.
     */
    it('empty graph emits no nodes', () => {
      const g = createCausl()
      expect(g.exportModel().nodes).toEqual([])
    })

    /**
     * Mixed graph: every emitted `kind` is one of the two literal
     * tags. The check is over `Set` membership rather than an
     * arm-by-arm probe so the assertion fails loudly if a third tag
     * leaks in.
     */
    it('mixed graph emits only input | derived tags', () => {
      const g = createCausl()
      const a = g.input('a', 1)
      const b = g.input('b', 2)
      g.derived('sum', (get) => get(a) + get(b))
      g.derived('twice-sum', (get) => 2 * (get(a) + get(b)))
      g.commit('bump', (tx) => tx.set(a, 10))
      const tags = new Set(g.exportModel().nodes.map((n) => n.kind))
      expect(tags).toEqual(new Set(['input', 'derived']))
    })

    /**
     * The schema's admitted-kind set matches the engine's emitted
     * set: two tags, no more. Catches a schema-side widening that
     * the engine never opted into and a engine-side widening that
     * the schema never opted into in the same assertion.
     */
    it('schema and engine agree on the closed two-tag set', () => {
      expect(new Set(ADMITTED_NODE_KINDS)).toEqual(new Set(['input', 'derived']))
    })
  })

  /**
   * Hand-rolled IR documents with unknown `kind` values fail the
   * schema's structural contract. The schema is the authoritative
   * wire-format; the Rust checker rejects the same shapes for the
   * same reason. This is how we keep adapter packages from
   * smuggling extra `kind` constants through the IR by hand.
   *
   * The probe walks the schema's `oneOf` arms in-line rather than
   * pulling in a JSON Schema validator dependency: the relevant
   * structural rule for this surface is "every node `kind` is one
   * of the declared `const`s," and the literal-set check captures
   * that exactly.
   */
  describe('hand-rolled unknown kinds fail the structural contract', () => {
    /**
     * `'resource'` was a valid `kind` constant in the prior schema;
     * it must now be outside the admitted set.
     */
    it("rejects 'resource' as an admitted node kind", () => {
      expect(ADMITTED_NODE_KINDS).not.toContain('resource')
    })

    /**
     * Symmetrically for `'conflict'` and `'msg'`.
     */
    it("rejects 'conflict' and 'msg' as admitted node kinds", () => {
      expect(ADMITTED_NODE_KINDS).not.toContain('conflict')
      expect(ADMITTED_NODE_KINDS).not.toContain('msg')
    })

    /**
     * Unknown adapter-fabricated kinds are likewise outside the set.
     * Belt-and-braces: a TypeScript caller that builds an IR object
     * with an arbitrary `kind` cannot satisfy the published `IRNode`
     * union (the assignment fails at the type level), and the
     * schema's `oneOf` rejects the same shape on the wire — the two
     * gates close on the same shape.
     */
    it('rejects an arbitrary unknown kind', () => {
      expect(ADMITTED_NODE_KINDS).not.toContain('workflow')
      expect(ADMITTED_NODE_KINDS).not.toContain('formula')
      expect(ADMITTED_NODE_KINDS).not.toContain('selector')
    })

    /**
     * The two declared tags are inside the set. Confirms the
     * literal-set extraction above is reading the schema correctly,
     * not silently dropping arms.
     */
    it('admits exactly input and derived', () => {
      expect(ADMITTED_NODE_KINDS).toContain('input')
      expect(ADMITTED_NODE_KINDS).toContain('derived')
      expect(ADMITTED_NODE_KINDS).toHaveLength(2)
    })

    /**
     * A hand-rolled valid IR document still type-checks against the
     * exported `CauslModel` shape. Round-trips through JSON for
     * wire-format stability.
     */
    it('hand-rolled two-primitive IR round-trips through JSON cleanly', () => {
      const doc: CauslModel = {
        schema: CAUSL_MODEL_SCHEMA,
        time: 0,
        nodes: [
          { kind: 'input', id: 'a', graphId: 'g.fixture', value: 1, serializable: true },
          {
            kind: 'derived',
            id: 'b',
            graphId: 'g.fixture',
            deps: ['a'],
            conditionalDeps: [],
            value: 2,
            serializable: true,
          },
        ],
        commits: [],
        events: [],
        scopes: [],
        bridges: [],
      }
      const round = JSON.parse(JSON.stringify(doc)) as CauslModel
      expect(round).toEqual(doc)
      const tags = new Set(round.nodes.map((n) => n.kind))
      expect(tags).toEqual(new Set(['input', 'derived']))
    })
  })
})
