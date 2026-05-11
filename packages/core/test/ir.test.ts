/**
 * @packageDocumentation
 *
 * Pins down the shape of the CauslModel intermediate representation
 * at the type level and in its companion JSON Schema.
 *
 * The IR is a public contract: the bridge between the TS engine and
 * the Rust bounded-model-checker. `graph.exportModel()` is its only
 * producer; the Rust binary `causl-check` is its consumer. Because
 * an external tool reads this document on every CI run, the wire
 * format has to be stable and self-describing — hence the schema
 * version constant, the closed top-level object, and the JSON Schema
 * mirror that lets the checker validate exported snapshots before it
 * tries to construct a state-space exploration over them.
 *
 * Tests confirm the schema version constant, that empty and populated
 * model literals type-check against the discriminated `nodes` union,
 * and that the published JSON Schema document advertises Draft-07,
 * the canonical `$id`, a fixed `schema` constant matching
 * `CAUSL_MODEL_SCHEMA`, and a closed top-level shape via
 * `additionalProperties: false`.
 */
import { describe, expect, it } from 'vitest'
import {
  CAUSL_MODEL_SCHEMA,
  causlModelJsonSchema,
  type CauslModel,
} from '../src/index.js'

/**
 * Suite covering the in-memory `CauslModel` IR: schema-version
 * pinning and the structural admissibility of empty and populated
 * model literals.
 */
describe('CauslModel IR', () => {
  /**
   * The exported schema-version constant is exactly `2` — the IR's
   * v2 contract is frozen at this number after the #359 collapse
   * back to two primitives (the wire-format break that retired the
   * optional `resources` / `conflicts` / `msgs` regions).
   */
  it('schema constant is 3', () => {
    // Assert: schema constant matches the documented v3 value (PR-A
    // of EPIC-1: graphId per node + commit, optional IRCallGraph,
    // forward-compat events: readonly never[]).
    expect(CAUSL_MODEL_SCHEMA).toBe(3)
  })

  /**
   * A model with no nodes and no commits is a valid `CauslModel`
   * literal.
   */
  it('supports an empty model', () => {
    // Arrange: construct the minimal valid model literal.
    const m: CauslModel = {
      schema: CAUSL_MODEL_SCHEMA,
      time: 0,
      nodes: [],
      commits: [],
      events: [],
      scopes: [],
      bridges: [],
    }
    // Assert: the empty `nodes` collection is preserved.
    expect(m.nodes.length).toBe(0)
    expect(m.events.length).toBe(0)
  })

  /**
   * A populated model carrying both an `input` and a `derived` node,
   * plus a commit referencing them, satisfies the IR's discriminated
   * `nodes` union.
   */
  it('supports input + derived nodes', () => {
    // Arrange: build a model with one input, one derived node, and
    // one commit that touches both.
    const m: CauslModel = {
      schema: CAUSL_MODEL_SCHEMA,
      time: 1,
      nodes: [
        { kind: 'input', id: 'a', graphId: 'g.test', value: 5, serializable: true },
        {
          kind: 'derived',
          id: 'sum',
          graphId: 'g.test',
          deps: ['a'],
          conditionalDeps: [],
          value: 5,
          serializable: true,
        },
      ],
      commits: [
        { time: 1, graphId: 'g.test', intent: 'bump', changedNodes: ['a', 'sum'] },
      ],
      events: [],
      scopes: [],
      bridges: [],
    }
    // Assert: each node's discriminant is preserved and addressable.
    expect(m.nodes[0]?.kind).toBe('input')
    expect(m.nodes[1]?.kind).toBe('derived')
  })
})

/**
 * Suite covering the published JSON Schema mirror of `CauslModel`,
 * used by external tooling to validate exported snapshots.
 */
describe('causlModelJsonSchema', () => {
  /**
   * The schema document declares Draft-07 dialect and the canonical
   * `causl-model-v3` `$id` (PR-B1 lifted the document to schema 3 by
   * adding `events`, `scopes`, `bridges`, and `graphId` on every node
   * and commit).
   */
  it('declares Draft-07 + correct $id', () => {
    // Assert: dialect and identity strings match the IR contract.
    expect(causlModelJsonSchema.$schema).toMatch(/draft-07/)
    expect(causlModelJsonSchema.$id).toContain('causl-model-v3')
  })

  /**
   * The `schema` property in the JSON Schema is pinned to the same
   * constant that `CAUSL_MODEL_SCHEMA` exports.
   */
  it('pins schema version to CAUSL_MODEL_SCHEMA', () => {
    // Assert: the JSON Schema's literal const matches the TS export.
    expect(causlModelJsonSchema.properties.schema.const).toBe(CAUSL_MODEL_SCHEMA)
  })

  /**
   * The top-level object is closed — unknown properties cause
   * validation failure rather than being silently accepted.
   */
  it('rejects additional properties at the top level', () => {
    // Assert: the schema sets `additionalProperties: false`.
    expect(causlModelJsonSchema.additionalProperties).toBe(false)
  })
})
