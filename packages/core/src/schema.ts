/**
 * @packageDocumentation
 *
 * JSON Schema (Draft-07) describing the {@link CauslModel} IR
 * defined in `./ir.ts`. Authoritative wire-format contract for the
 * boundary between the TypeScript engine and the Rust
 * `causl-check` binary — the bounded model checker that consumes
 * the IR and enumerates reachable states within configurable bounds
 * (`--max-nodes`, `--max-commits`). The Rust crate regenerates an
 * equivalent schema via `serde_json` / `schemars` whenever the IR
 * shape changes; this document and the Rust schema are kept in
 * lock-step so a mismatch is caught up-front rather than turning
 * into a silent model-decoding bug.
 *
 * Two-primitive discipline (§4). The schema closes the `nodes` array
 * over exactly two `kind` constants — `'input'` and `'derived'` — and
 * forbids additional top-level properties via `additionalProperties:
 * false`. The earlier draft of this document advertised optional
 * `resources`, `conflicts`, and `msgs` arrays each carrying its own
 * `kind` constant; that surface taught downstream consumers (Rust
 * checker, generated bindings, schema-derived types) the eleven-kind
 * taxonomy §4 was written to refuse, and was removed in #359.
 */

import { CAUSL_MODEL_SCHEMA } from './ir.js'

/**
 * Draft-07 JSON Schema document for the CauslModel IR.
 *
 * @remarks
 * The schema is `as const` so consumers can derive a precise literal
 * type ({@link CauslModelJsonSchema}) for compile-time validation
 * tooling. Validation libraries (Ajv, etc.) accept the value
 * directly at runtime.
 *
 * Schema 3 (PR-B1). Every node and commit carries `graphId` (the
 * multi-graph foreign key); the top-level document also carries the
 * `events` lifecycle stream, the `scopes` registry resolved by
 * `IRSubscribe.scopeId`, and the `bridges` allowlist consumed by
 * EPIC-2's `CrossGraphRead` pass. Each event variant is closed under
 * `oneOf` over its `kind` discriminator — `subscribe`,
 * `subscribe-callback`, `unsubscribe`, `dispose`, `read`, `tx-set`.
 *
 * @see {@link CAUSL_MODEL_SCHEMA}
 */
export const causlModelJsonSchema = {
  // Document-level metadata: dialect, identifier, and human-readable title.
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://causl.dev/schemas/causl-model-v3.json',
  title: 'CauslModel',
  type: 'object',
  // Top-level required keys; mirrors the CauslModel interface.
  // The shape is closed by `additionalProperties: false`: schema 3
  // adds `events` (lifecycle stream), `scopes` (scope registry), and
  // `bridges` (cross-graph allowlist). Adapter packages that need
  // richer model state ship a sibling document the checker reads
  // alongside the engine IR; they do not extend `CauslModel` itself.
  required: ['schema', 'time', 'nodes', 'commits', 'events', 'scopes', 'bridges'],
  additionalProperties: false,
  properties: {
    // Pinned schema version: must equal CAUSL_MODEL_SCHEMA exactly.
    schema: { const: CAUSL_MODEL_SCHEMA },
    // GraphTime is a non-negative integer counting committed moments.
    time: { type: 'integer', minimum: 0 },
    // Node array: each element is either an IRInput or an IRDerived.
    // The `oneOf` is the wire-level expression of §4's two-primitive
    // commitment — adding a third arm here would be a schema break
    // and must clear the same bar as adding a third `kind` to the
    // engine's runtime universe.
    nodes: {
      type: 'array',
      items: {
        oneOf: [
          // IRInput shape — writable Behavior snapshot.
          {
            type: 'object',
            required: ['kind', 'id', 'graphId', 'value', 'serializable'],
            additionalProperties: false,
            properties: {
              kind: { const: 'input' },
              id: { type: 'string', minLength: 1 },
              graphId: { type: 'string', minLength: 1 },
              value: {},
              serializable: { type: 'boolean' },
            },
          },
          // IRDerived shape — composed Behavior with dep edges.
          {
            type: 'object',
            required: ['kind', 'id', 'graphId', 'deps', 'conditionalDeps', 'value', 'serializable'],
            additionalProperties: false,
            properties: {
              kind: { const: 'derived' },
              id: { type: 'string', minLength: 1 },
              graphId: { type: 'string', minLength: 1 },
              deps: { type: 'array', items: { type: 'string' } },
              conditionalDeps: { type: 'array', items: { type: 'string' } },
              value: {},
              serializable: { type: 'boolean' },
            },
          },
        ],
      },
    },
    // Capped commit log used for replay-determinism checks. Each
    // commit carries `graphId` (schema-3 multi-graph foreign key); the
    // optional `originatedAt`, `callGraph`, and `originEvent` fields
    // are reserved by schema 3 and emitted by the exporter when their
    // capture options are enabled.
    commits: {
      type: 'array',
      items: {
        type: 'object',
        required: ['time', 'graphId', 'intent', 'changedNodes'],
        additionalProperties: false,
        properties: {
          time: { type: 'integer', minimum: 0 },
          graphId: { type: 'string', minLength: 1 },
          intent: { type: 'string' },
          changedNodes: { type: 'array', items: { type: 'string' } },
          originatedAt: { type: 'integer', minimum: 0 },
          callGraph: {
            type: 'object',
            required: ['frames', 'truncatedDeeper'],
            additionalProperties: false,
            properties: {
              frames: { type: 'array' },
              truncatedDeeper: { type: 'boolean' },
            },
          },
          originEvent: { type: 'string' },
        },
      },
    },
    // Lifecycle event stream. Closed under `oneOf` on the `kind`
    // discriminator. Adding a seventh variant requires bumping the
    // schema and is caught at every `assertNever`-guarded reading
    // site in the engine and the checker.
    events: {
      type: 'array',
      items: {
        oneOf: [
          // IRSubscribe — observer registration.
          {
            type: 'object',
            required: ['kind', 'graphId', 'id', 'scopeId', 'target', 'callbackSite', 'time'],
            additionalProperties: false,
            properties: {
              kind: { const: 'subscribe' },
              graphId: { type: 'string', minLength: 1 },
              id: { type: 'string', minLength: 1 },
              scopeId: { type: 'string', minLength: 1 },
              target: { type: 'string', minLength: 1 },
              callbackSite: { type: 'string' },
              time: { type: 'integer', minimum: 0 },
            },
          },
          // IRSubscribeCallback — observer invocation frame.
          {
            type: 'object',
            required: ['kind', 'graphId', 'id', 'subscribeId', 'firedAt'],
            additionalProperties: false,
            properties: {
              kind: { const: 'subscribe-callback' },
              graphId: { type: 'string', minLength: 1 },
              id: { type: 'string', minLength: 1 },
              subscribeId: { type: 'string', minLength: 1 },
              firedAt: { type: 'integer', minimum: 0 },
            },
          },
          // IRUnsubscribe — subscription teardown.
          {
            type: 'object',
            required: ['kind', 'graphId', 'id', 'scopeId', 'time'],
            additionalProperties: false,
            properties: {
              kind: { const: 'unsubscribe' },
              graphId: { type: 'string', minLength: 1 },
              id: { type: 'string', minLength: 1 },
              scopeId: { type: 'string', minLength: 1 },
              time: { type: 'integer', minimum: 0 },
            },
          },
          // IRDispose — node removal with half-open
          // [enqueueAt, appliedAt] interval per the brutal-critical
          // review's recommendation #5.
          {
            type: 'object',
            required: ['kind', 'graphId', 'nodeId', 'scopeId', 'time', 'disposeAt'],
            additionalProperties: false,
            properties: {
              kind: { const: 'dispose' },
              graphId: { type: 'string', minLength: 1 },
              nodeId: { type: 'string', minLength: 1 },
              scopeId: { type: 'string', minLength: 1 },
              time: { type: 'integer', minimum: 0 },
              disposeAt: {
                type: 'array',
                items: { type: 'integer', minimum: 0 },
              },
            },
          },
          // IRRead — per-commit derived-read summary.
          {
            type: 'object',
            required: ['kind', 'graphId', 'derivedId', 'readNodeId', 'time', 'seq', 'truncated'],
            additionalProperties: false,
            properties: {
              kind: { const: 'read' },
              graphId: { type: 'string', minLength: 1 },
              derivedId: { type: 'string', minLength: 1 },
              readNodeId: { type: 'string', minLength: 1 },
              time: { type: 'integer', minimum: 0 },
              seq: { type: 'integer', minimum: 0 },
              truncated: { type: 'boolean' },
            },
          },
          // IRTxSet — `tx.set(input, value)` event.
          {
            type: 'object',
            required: ['kind', 'graphId', 'inputId', 'time'],
            additionalProperties: false,
            properties: {
              kind: { const: 'tx-set' },
              graphId: { type: 'string', minLength: 1 },
              inputId: { type: 'string', minLength: 1 },
              time: { type: 'integer', minimum: 0 },
            },
          },
        ],
      },
    },
    // Lifecycle scopes referenced by IRSubscribe / IRUnsubscribe /
    // IRDispose. Closed at three `kind` arms.
    scopes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'kind', 'lifetime'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1 },
          kind: { enum: ['ephemeral', 'infinite', 'process-exit'] },
          lifetime: {
            type: 'object',
            required: ['origin', 'terminator'],
            additionalProperties: false,
            properties: {
              origin: { type: 'string' },
              terminator: { type: 'string' },
            },
          },
        },
      },
    },
    // Sanctioned cross-graph dependency declarations. Closed at
    // three `policy` arms.
    bridges: {
      type: 'array',
      items: {
        type: 'object',
        required: ['from', 'to', 'dep', 'policy'],
        additionalProperties: false,
        properties: {
          from: { type: 'string', minLength: 1 },
          to: { type: 'string', minLength: 1 },
          dep: { type: 'string', minLength: 1 },
          policy: { enum: ['legacy-allow', 'test-only', 'read-only'] },
        },
      },
    },
  },
} as const

/**
 * Compile-time literal type of {@link causlModelJsonSchema}.
 *
 * @remarks
 * Useful for downstream tooling that wants to derive precise types
 * from the schema document (e.g. `json-schema-to-ts`).
 */
export type CauslModelJsonSchema = typeof causlModelJsonSchema
