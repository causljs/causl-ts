/**
 * @packageDocumentation
 *
 * Property suite pinning the IR extension surface (EPIC #282 sub-issue
 * #286). Three load-bearing properties, each running the §15.2 1000-
 * trial floor inherited from {@link propertyOptions}:
 *
 * 1. **Schema validity** — every IR document `graph.exportModel()`
 *    emits parses against the JSON Schema document
 *    `causlModelJsonSchema`. The schema is the wire-format contract
 *    the Rust `causl-check` binary regenerates and validates against;
 *    a divergence between what the engine emits and what the schema
 *    declares would surface as a model-decoding failure on the Rust
 *    side, not as a typecheck failure here. The property is the runtime
 *    seam that closes that gap.
 *
 * 2. **Round-trip equality** — `parse(stringify(exportModel())) ===
 *    exportModel()` (deep-equal). Asserts the IR is JSON-clean: no
 *    `undefined` slots that survive the serialiser as `null`, no
 *    `Date`/`Map`/`Set` objects that round-trip lossy, no field
 *    aliasing that re-orders array contents through the JSON pass.
 *    The IR ships across the Rust FFI as a string; lossy round-trip
 *    here is a silent corruption there.
 *
 * 3. **Schema-version stability** — every emitted IR carries
 *    `schema: CAUSL_MODEL_SCHEMA` (=2 after #359). The IR-extension
 *    surface landed in EPIC #282 sub-issue #286 was retired by #359
 *    (the wire-format break that collapsed the IR back to two
 *    primitives), and the version pin moves with it. The property
 *    guards against accidental further bumps by sweeping through
 *    random graphs and traces and asserting the constant on every
 *    export.
 *
 * History: EPIC #282 sub-issue #286 introduced the optional
 * `resources` / `conflicts` / `msgs` regions on `CauslModel`;
 * #359 retired them in service of §4's two-primitive discipline.
 * The properties below survive the retirement because they were
 * never about the extension fields specifically — they pin the
 * structural contract between the engine emitter and the schema.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  buildPropertyDag,
  propertyDag,
  type DagSpec,
} from '@causljs/core-testing-internal'
import {
  createCausl,
  CAUSL_MODEL_SCHEMA,
  causlModelJsonSchema,
  type Graph,
  type InputNode,
  type CauslModel,
} from '../../src/index.js'
import { tieredPropertyOptions } from './seed.js'

/**
 * Minimal Draft-07 JSON Schema validator covering the subset of
 * keywords used by `causlModelJsonSchema` (`type`, `const`, `enum`,
 * `required`, `additionalProperties`, `properties`, `items`, `oneOf`,
 * `minimum`, `minLength`). A full Ajv dependency would carry the
 * checker-side validator into the engine package; the schema stays
 * intentionally narrow so this 80-line walker is sufficient.
 *
 * Returns the empty array on success, or a list of `path: message`
 * failure strings the property reporter surfaces verbatim.
 */
function validate(value: unknown, schema: unknown, path = '$'): readonly string[] {
  const out: string[] = []
  walk(value, schema, path, out)
  return out
}

/**
 * Recursive walker driving {@link validate}. Tracks the JSON pointer
 * path so failure messages localise to the offending field rather
 * than dumping the full document on every error.
 */
function walk(value: unknown, schema: unknown, path: string, out: string[]): void {
  if (typeof schema !== 'object' || schema === null) {
    return
  }
  const s = schema as Record<string, unknown>
  // `const` — exact-value match.
  if ('const' in s && !Object.is(value, s['const'])) {
    out.push(`${path}: const mismatch (expected ${JSON.stringify(s['const'])}, got ${JSON.stringify(value)})`)
    return
  }
  // `enum` — membership in a literal set.
  if (Array.isArray(s['enum'])) {
    if (!(s['enum'] as readonly unknown[]).includes(value)) {
      out.push(`${path}: enum mismatch (got ${JSON.stringify(value)})`)
      return
    }
  }
  // `oneOf` — exactly one of the alternatives must match.
  if (Array.isArray(s['oneOf'])) {
    const branches = s['oneOf'] as readonly unknown[]
    let matches = 0
    let lastErrors: readonly string[] = []
    for (const branch of branches) {
      const errs = validate(value, branch, path)
      if (errs.length === 0) {
        matches++
      } else {
        lastErrors = errs
      }
    }
    if (matches !== 1) {
      out.push(
        `${path}: oneOf matched ${matches} branches (need exactly 1); last branch errors: ${lastErrors.join('; ')}`,
      )
      return
    }
  }
  // `type` — JSON-Schema primitive families. We only emit `object`,
  // `array`, `string`, `integer`, `boolean` from our schema document.
  if (typeof s['type'] === 'string') {
    const t = s['type']
    if (t === 'object' && (typeof value !== 'object' || value === null || Array.isArray(value))) {
      out.push(`${path}: expected object, got ${describeType(value)}`)
      return
    }
    if (t === 'array' && !Array.isArray(value)) {
      out.push(`${path}: expected array, got ${describeType(value)}`)
      return
    }
    if (t === 'string' && typeof value !== 'string') {
      out.push(`${path}: expected string, got ${describeType(value)}`)
      return
    }
    if (t === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))) {
      out.push(`${path}: expected integer, got ${describeType(value)}`)
      return
    }
    if (t === 'boolean' && typeof value !== 'boolean') {
      out.push(`${path}: expected boolean, got ${describeType(value)}`)
      return
    }
  }
  // `minimum` — numeric lower bound.
  if (typeof s['minimum'] === 'number' && typeof value === 'number') {
    if (value < (s['minimum'] as number)) {
      out.push(`${path}: minimum ${s['minimum'] as number} violated (got ${value})`)
    }
  }
  // `minLength` — string lower bound on length.
  if (typeof s['minLength'] === 'number' && typeof value === 'string') {
    if (value.length < (s['minLength'] as number)) {
      out.push(`${path}: minLength ${s['minLength'] as number} violated`)
    }
  }
  // Object-shape descent: required keys, declared properties,
  // additionalProperties=false.
  if (s['type'] === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    if (Array.isArray(s['required'])) {
      for (const r of s['required'] as readonly string[]) {
        if (!(r in obj)) {
          out.push(`${path}: missing required field '${r}'`)
        }
      }
    }
    const declared = (s['properties'] as Record<string, unknown> | undefined) ?? {}
    if (s['additionalProperties'] === false) {
      for (const k of Object.keys(obj)) {
        if (!(k in declared)) {
          out.push(`${path}: additional property '${k}' not allowed`)
        }
      }
    }
    for (const [k, sub] of Object.entries(declared)) {
      if (k in obj) {
        walk(obj[k], sub, `${path}.${k}`, out)
      }
    }
  }
  // Array-shape descent: items applied to every element.
  if (s['type'] === 'array' && Array.isArray(value) && s['items']) {
    for (let i = 0; i < value.length; i++) {
      walk(value[i], s['items'], `${path}[${i}]`, out)
    }
  }
}

/**
 * One-line type-tag for failure messages — JSON's primitive vocabulary.
 */
function describeType(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

/**
 * Build a graph from a {@link DagSpec} so the property body has a
 * single shape it can replay-and-export against.
 */
function buildMatching(spec: DagSpec): {
  readonly graph: Graph
  readonly input: InputNode<number>
} {
  const graph = createCausl()
  const built = buildPropertyDag(graph, spec)
  return { graph, input: built.input }
}

/**
 * Replay a list of integer writes against the input. Each write is
 * one commit, advancing GraphTime by exactly one (the §3 atomicity
 * invariant) — the trace shape mirrors `snapshot-roundtrip` so the
 * fuzz coverage is consistent across IR-related properties.
 */
function replay(
  graph: Graph,
  input: InputNode<number>,
  writes: readonly number[],
  prefix: string,
): void {
  for (let i = 0; i < writes.length; i++) {
    const v = writes[i] ?? 0
    graph.commit(`${prefix}-${i}`, (tx) => tx.set(input, v))
  }
}

describe('property: IR structural contract (#359 / EPIC #282 / #286)', () => {
  /**
   * P1 — schema validity.
   *
   * For every random DAG and every random write trace, the IR
   * `graph.exportModel()` emits validates against the JSON Schema
   * document `causlModelJsonSchema`. Catches drift between the
   * engine's emitter and the schema (the wire-format contract the
   * Rust checker regenerates from `schemars` and validates against).
   * Any new field added to one without the other surfaces here on
   * the first trial.
   */
  it('every emitted IR document validates against the JSON Schema (≥1000 cases)', () => {
    fc.assert(
      fc.property(
        propertyDag({ minDerived: 0, maxDerived: 8 }),
        fc.array(fc.integer({ min: -1_000, max: 1_000 }), {
          minLength: 0,
          maxLength: 25,
        }),
        (spec, writes) => {
          const built = buildMatching(spec)
          replay(built.graph, built.input, writes, 'p1')
          const model = built.graph.exportModel()
          const errors = validate(model, causlModelJsonSchema)
          if (errors.length > 0) {
            // Surface a focused failure message — the model is the
            // counterexample, the schema errors are the diagnosis.
            throw new Error(
              `IR did not validate against schema: ${errors.join(' | ')}`,
            )
          }
        },
      ),
      tieredPropertyOptions(),
    )
  })

  /**
   * P2 — JSON round-trip equality.
   *
   * `parse(stringify(exportModel()))` deep-equals `exportModel()`.
   * The IR ships across the Rust FFI as a string; any field the
   * serialiser drops (e.g. `undefined` -> absent vs. present-but-
   * undefined, `Map`/`Set` instances that JSON.stringify silently
   * collapses to `{}`) corrupts the model on the checker side. The
   * property sweeps random graphs and traces to catch drift in the
   * emit path that lossless examples might miss.
   */
  it('parse(stringify(exportModel())) deep-equals exportModel() (≥1000 cases)', () => {
    fc.assert(
      fc.property(
        propertyDag({ minDerived: 0, maxDerived: 8 }),
        fc.array(fc.integer({ min: -1_000, max: 1_000 }), {
          minLength: 0,
          maxLength: 25,
        }),
        (spec, writes) => {
          const built = buildMatching(spec)
          replay(built.graph, built.input, writes, 'p2')
          const model = built.graph.exportModel()
          const round = JSON.parse(JSON.stringify(model)) as CauslModel
          expect(round).toEqual(model)
        },
      ),
      tieredPropertyOptions(),
    )
  })

  /**
   * P3 — schema-version stability.
   *
   * Every emitted IR carries `schema: CAUSL_MODEL_SCHEMA` (=3 after
   * EPIC-1 PR-A introduced multi-graph IR; PR-B1 widens the IR with
   * `IREvent`, `IRScope`, `IRBridge` without bumping the constant).
   * A future change that bumps the version without coordinating with
   * the Rust checker would surface here on the first trial; the
   * property is the structural guard against accidental breakage.
   */
  it('every emitted IR includes schemaVersion === 3 (≥1000 cases)', () => {
    fc.assert(
      fc.property(
        propertyDag({ minDerived: 0, maxDerived: 8 }),
        fc.array(fc.integer({ min: -1_000, max: 1_000 }), {
          minLength: 0,
          maxLength: 25,
        }),
        (spec, writes) => {
          const built = buildMatching(spec)
          replay(built.graph, built.input, writes, 'p3')
          const model = built.graph.exportModel()
          expect(model.schema).toBe(CAUSL_MODEL_SCHEMA)
          expect(model.schema).toBe(3)
        },
      ),
      tieredPropertyOptions(),
    )
  })
})
