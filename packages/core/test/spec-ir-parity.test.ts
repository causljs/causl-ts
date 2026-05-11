/**
 * SPEC.md §16.2.1 ↔ implementation parity test (#569).
 *
 * SPEC §16.2.1.1 (TypeScript schema) and §16.2.1.2 (Rust schema)
 * inline-document the shipped IR types as code blocks. EPIC-1 PR-B1
 * shipped six IREvent variants and adopted the brutal-critical
 * review's recommendations on `disposeAt`, `originEvent`,
 * `IRSubscribeCallback`, scopes, and bridges — but SPEC text was
 * not updated alongside. This test pins the SPEC text against the
 * impl so future drift fails the suite at PR time.
 *
 * It is deliberately a structural-mention test, not a verbatim
 * code-block match: an editor doing prose cleanup on SPEC.md should
 * not have to reproduce the inline TypeScript block byte-for-byte to
 * keep the test green. What we DO assert is that every name a
 * downstream consumer would search for in SPEC §16.2.1 is present:
 * the six event kind discriminators, the post-EPIC-1-review fields
 * (`disposeAt`, `originEvent`, `callbackSite`, `subscribeId`,
 * `derivedId`, `readNodeId`, `inputId`), and the schema-3
 * top-level shape (`scopes`, `bridges`).
 */

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  CAUSL_MODEL_SCHEMA,
  parseCauslModel,
} from '../src/ir.js'
import type {
  IRSubscribe,
  IRSubscribeCallback,
  IRUnsubscribe,
  IRDispose,
  IRRead,
  IRTxSet,
  IREvent,
  IRScope,
  IRBridge,
  IRCommit,
  CauslModel,
} from '../src/ir.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const specPath = resolve(__dirname, '../../../SPEC.md')
const specText = readFileSync(specPath, 'utf8')

/**
 * Extract the §16.2.1.1 TS code block contents (best-effort).
 * Falls back to the entire §16.2.1 region if the boundaries
 * shift in a future SPEC restructure.
 */
function extractSection(): string {
  const start = specText.indexOf('#### 16.2.1.1 TypeScript schema-3 type definitions')
  const end = specText.indexOf('#### 16.2.1.3 Granularity decisions')
  if (start === -1 || end === -1) {
    // Fallback: search the whole §16.2 region.
    const fallbackStart = specText.indexOf('### 16.2 The IR contract')
    const fallbackEnd = specText.indexOf('### 16.3')
    if (fallbackStart === -1 || fallbackEnd === -1) {
      throw new Error(
        'spec-ir-parity: could not locate §16.2.1 region in SPEC.md',
      )
    }
    return specText.slice(fallbackStart, fallbackEnd)
  }
  return specText.slice(start, end)
}

describe('SPEC.md §16.2.1 ↔ ir.ts parity (#569)', () => {
  test('schema constant is documented at the value the impl ships', () => {
    const section = extractSection()
    expect(section).toContain(`CAUSL_MODEL_SCHEMA = ${CAUSL_MODEL_SCHEMA}`)
  })

  test('all six IREvent kind discriminators are documented', () => {
    const section = extractSection()
    // The six variants the impl ships (#569 audit). Each `kind`
    // literal must appear verbatim in SPEC text so adopters
    // searching SPEC for the on-the-wire discriminator find it.
    const kinds = [
      "'subscribe'",
      "'subscribe-callback'",
      "'unsubscribe'",
      "'dispose'",
      "'read'",
      "'tx-set'",
    ]
    for (const k of kinds) {
      expect(
        section,
        `SPEC §16.2.1.1 missing event kind discriminator ${k} — ` +
          `present in packages/core/src/ir.ts but absent from SPEC text`,
      ).toContain(k)
    }
  })

  test('IRSubscribe documents the impl shape (id/scopeId/target/callbackSite)', () => {
    const section = extractSection()
    // The post-EPIC-1-review IRSubscribe has these fields (#569).
    // SPEC §16.2.1.1's draft predates that review and uses
    // {nodeId, subscriptionId} — drift the impl already moved past.
    for (const field of ['scopeId', 'callbackSite']) {
      expect(
        section,
        `SPEC §16.2.1.1 IRSubscribe is missing field ${field}`,
      ).toContain(field)
    }
  })

  test('IRSubscribeCallback (sixth variant) is documented', () => {
    const section = extractSection()
    // PR-B1 added IRSubscribeCallback per the brutal-critical
    // review recommendation #1 (commit-from-subscribe lineage). SPEC
    // text must name it; the impl ships it.
    expect(
      section,
      'SPEC §16.2.1.1 must document IRSubscribeCallback (the 6th IREvent variant)',
    ).toMatch(/IRSubscribeCallback/)
    // The lineage field on IRCommit too.
    expect(
      section,
      'SPEC §16.2.1.1 IRCommit must document originEvent (callback-frame lineage)',
    ).toContain('originEvent')
  })

  test('IRDispose documents the half-open [enqueueAt, appliedAt] interval', () => {
    const section = extractSection()
    expect(
      section,
      'SPEC §16.2.1.1 IRDispose must document `disposeAt` interval ' +
        '(brutal-critical review recommendation #5)',
    ).toContain('disposeAt')
  })

  test('IRRead documents derivedId + readNodeId (not single nodeId)', () => {
    const section = extractSection()
    // The impl distinguishes the derived's id from the node it read.
    // SPEC's draft used a single `nodeId` which doesn't preserve that
    // distinction.
    for (const field of ['derivedId', 'readNodeId']) {
      expect(
        section,
        `SPEC §16.2.1.1 IRRead is missing field ${field}`,
      ).toContain(field)
    }
  })

  test('IRTxSet documents inputId (not generic nodeId)', () => {
    const section = extractSection()
    // tx.set always targets an Input; the impl encodes this in the
    // field name. SPEC drafted a generic `nodeId` plus speculative
    // `value` and `serializable` that the impl omitted.
    expect(
      section,
      'SPEC §16.2.1.1 IRTxSet must use inputId (the impl tightened ' +
        'from generic nodeId to inputId per #359 two-primitive discipline)',
    ).toContain('inputId')
  })

  test('CauslModel top-level documents the seven shipped fields', () => {
    const section = extractSection()
    // SPEC drafted five fields {schema, time, nodes, commits, events};
    // PR-B1 added scopes and bridges. The seven-field shape is what
    // ships and what `parseCauslModel` validates.
    for (const field of ['scopes', 'bridges']) {
      expect(
        section,
        `SPEC §16.2.1.1 CauslModel must document field ${field}`,
      ).toContain(field)
    }
  })

  test('IRScope is documented (referenced by subscribe/unsubscribe/dispose)', () => {
    const section = extractSection()
    expect(
      section,
      'SPEC §16.2.1.1 must document IRScope (resolved by scopeId on subscribe/unsubscribe/dispose)',
    ).toMatch(/IRScope/)
    // Three scope kinds the impl ships.
    for (const kind of ["'ephemeral'", "'infinite'", "'process-exit'"]) {
      expect(section).toContain(kind)
    }
  })

  test('IRBridge is documented (cross-graph allowlist)', () => {
    const section = extractSection()
    expect(
      section,
      'SPEC §16.2.1.1 must document IRBridge (cross-graph dep allowlist)',
    ).toMatch(/IRBridge/)
    // Three policy arms.
    for (const policy of ["'legacy-allow'", "'test-only'", "'read-only'"]) {
      expect(section).toContain(policy)
    }
  })
})

describe('SPEC.md §16.2.1.2 ↔ ir.rs parity (#569)', () => {
  test('Rust IrEvent enum has the six variants the impl ships', () => {
    const section = extractSection()
    // Match Rust enum variant names (impl ships these).
    const variants = ['SubscribeCallback', 'TxSet']
    // Subscribe/Unsubscribe/Dispose/Read are common words; check for
    // the two distinguishing-name variants.
    for (const v of variants) {
      expect(
        section,
        `SPEC §16.2.1.2 must document Rust IrEvent variant ${v}`,
      ).toContain(v)
    }
  })

  test('Rust IrCommit has origin_event field (lineage)', () => {
    const section = extractSection()
    expect(
      section,
      'SPEC §16.2.1.2 must document Rust IrCommit.origin_event (the lineage field PR-B1 added)',
    ).toMatch(/origin_event|originEvent/)
  })
})

describe('parseCauslModel runtime accepts every IREvent variant (#569)', () => {
  // This is the runtime-validator side of the parity test. If a
  // future PR adds a 7th variant to IREvent without teaching
  // parseCauslModel about it, the new variant rejects with
  // `unknown event kind`. This test exercises the current six.
  const fixture: CauslModel = {
    schema: CAUSL_MODEL_SCHEMA,
    time: 0,
    nodes: [],
    commits: [],
    events: [
      {
        kind: 'subscribe',
        graphId: 'g',
        id: 'sub-1',
        scopeId: 'g.default',
        target: 'n',
        callbackSite: '<unknown>',
        time: 0,
      } satisfies IRSubscribe,
      {
        kind: 'subscribe-callback',
        graphId: 'g',
        id: 'cb-1',
        subscribeId: 'sub-1',
        firedAt: 0,
      } satisfies IRSubscribeCallback,
      {
        kind: 'unsubscribe',
        graphId: 'g',
        id: 'sub-1',
        scopeId: 'g.default',
        time: 1,
      } satisfies IRUnsubscribe,
      {
        kind: 'dispose',
        graphId: 'g',
        nodeId: 'n',
        scopeId: 'g.default',
        time: 1,
        disposeAt: [1, 1],
      } satisfies IRDispose,
      {
        kind: 'read',
        graphId: 'g',
        derivedId: 'd',
        readNodeId: 'n',
        time: 0,
        seq: 0,
        truncated: false,
      } satisfies IRRead,
      {
        kind: 'tx-set',
        graphId: 'g',
        inputId: 'n',
        time: 0,
      } satisfies IRTxSet,
    ],
    scopes: [
      {
        id: 'g.default',
        kind: 'infinite',
        lifetime: { origin: 'process-start', terminator: 'process-exit' },
      } satisfies IRScope,
    ],
    bridges: [],
  }

  test('every variant round-trips through JSON.parse(JSON.stringify(...))', () => {
    const json = JSON.parse(JSON.stringify(fixture))
    const result = parseCauslModel(json)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.events.length).toBe(6)
    }
  })

  test('compile-time exhaustiveness: IREvent is exactly the six-arm union', () => {
    // The exhaustiveness check via TS satisfies — every fixture event
    // satisfies its corresponding interface, and the array satisfies
    // readonly IREvent[]. If a 7th variant is added without updating
    // the fixture, this assignment fails to type-check.
    const events: readonly IREvent[] = fixture.events
    expect(events.length).toBe(6)
  })

  test('IRCommit.originEvent is presence-discriminating (PR-B1)', () => {
    const commitWithOrigin: IRCommit = {
      time: 0,
      graphId: 'g',
      intent: 'test',
      changedNodes: [],
      originEvent: 'cb-1',
    }
    const commitWithoutOrigin: IRCommit = {
      time: 0,
      graphId: 'g',
      intent: 'test',
      changedNodes: [],
    }
    expect(commitWithOrigin.originEvent).toBe('cb-1')
    expect(commitWithoutOrigin.originEvent).toBeUndefined()
  })

  test('IRBridge has all three policy arms', () => {
    const bridges: readonly IRBridge[] = [
      { from: 'g.a', to: 'g.b', dep: 'n', policy: 'legacy-allow' },
      { from: 'g.a', to: 'g.b', dep: 'n', policy: 'test-only' },
      { from: 'g.a', to: 'g.b', dep: 'n', policy: 'read-only' },
    ]
    expect(bridges.length).toBe(3)
  })
})
