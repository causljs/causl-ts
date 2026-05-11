/**
 * @packageDocumentation
 *
 * EPIC-1 PR-B1 / TASK 1.B1.1 — TypeScript schema-3 IREvent variants +
 * IRScope + IRBridge tests.
 *
 * PR-A (commit `99f8369`, PR #462) shipped `IREvent = never` deliberately
 * — Beck's TDD discipline: do not commit to a union shape without the
 * consumer in code review. EPIC-2's lint passes (SPEC §16A.2.1) named
 * the fields the passes pattern-match against; this file pins those
 * fields against silent widening.
 *
 * Tests run under `vitest`'s `expectTypeOf` (in-suite type-level
 * assertions, no separate `tsd` runner) plus runtime assertions on
 * `JSON.parse(JSON.stringify(...))` round-trip behaviour and on the
 * structural validator `parseCauslModel`.
 *
 * Each test pins one of the 5 core concerns from issue #466:
 *   1. Discriminator literal closure (assertNever exhaustiveness)
 *   2. `IRDispose.disposeAt` is a half-open tuple `[number, number]`
 *   3. `IRCommit.originEvent?` presence-discriminator
 *   4. `CauslModel` top-level shape is exactly seven fields
 *   5. `graphId` required on every variant
 *
 * Wirfs-Brock's framing: every `kind` literal string is an on-the-wire
 * discriminator; the literal must match the Rust serde rename
 * byte-for-byte. The `as const` discipline carries through every
 * variant so `tsc` rejects a stray widening to `string`.
 */

import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  CAUSL_MODEL_SCHEMA,
  type CauslModel,
  type IRBridge,
  type IRCommit,
  type IRDispose,
  type IREvent,
  type IRGraphId,
  type IRRead,
  type IRScope,
  type IRSubscribe,
  type IRSubscribeCallback,
  type IRTxSet,
  type IRUnsubscribe,
  parseCauslModel,
} from '../src/ir.js'
import { assertNever } from '../src/internal.js'

// ─── Type-level fixtures (TASK 1.B1.1 tests 1-5) ──────────────────────

describe('TASK 1.B1.1 / type-d — IREvent union closure', () => {
  /**
   * Test 1 — `IREvent` is exhaustively the six-variant discriminated
   * union the EPIC-2 passes consume. `assertNever` in the default arm
   * catches a stray seventh variant at compile time.
   */
  it('IREvent is exhaustively `subscribe | subscribe-callback | unsubscribe | dispose | read | tx-set`', () => {
    type Discriminators = IREvent['kind']
    expectTypeOf<Discriminators>().toEqualTypeOf<
      | 'subscribe'
      | 'subscribe-callback'
      | 'unsubscribe'
      | 'dispose'
      | 'read'
      | 'tx-set'
    >()

    function visit(e: IREvent): string {
      switch (e.kind) {
        case 'subscribe':
          return e.id
        case 'subscribe-callback':
          return e.subscribeId
        case 'unsubscribe':
          return e.id
        case 'dispose':
          return e.nodeId
        case 'read':
          return e.derivedId
        case 'tx-set':
          return e.inputId
        default:
          return assertNever(e, 'IREvent: unknown kind')
      }
    }
    expect(visit({
      kind: 'subscribe',
      graphId: 'g.test',
      id: 's.1',
      scopeId: 'sc.1',
      target: 'n.1',
      callbackSite: 'src/x.ts:1:1',
      time: 0,
    })).toBe('s.1')
  })

  /**
   * Test 2 — every `IREvent` variant carries `graphId: IRGraphId` as a
   * required field, not optional. Carries forward PR-A's TASK 1.1
   * concern #3 (graphId on every record) into the now-real variants.
   */
  it('every IREvent variant carries graphId as required', () => {
    expectTypeOf<IRSubscribe>().toHaveProperty('graphId').toEqualTypeOf<IRGraphId>()
    expectTypeOf<IRSubscribeCallback>().toHaveProperty('graphId').toEqualTypeOf<IRGraphId>()
    expectTypeOf<IRUnsubscribe>().toHaveProperty('graphId').toEqualTypeOf<IRGraphId>()
    expectTypeOf<IRDispose>().toHaveProperty('graphId').toEqualTypeOf<IRGraphId>()
    expectTypeOf<IRRead>().toHaveProperty('graphId').toEqualTypeOf<IRGraphId>()
    expectTypeOf<IRTxSet>().toHaveProperty('graphId').toEqualTypeOf<IRGraphId>()
  })

  /**
   * Test 3 — `IRDispose.disposeAt` is a half-open tuple
   * `readonly [number, number]`, not `number`. The half-open interval
   * is the brutal-critical review's recommendation — EPIC-2's
   * `UseAfterDispose` pass compares `read.time` against `appliedAt`
   * (the moment the dispose became visible), not `enqueueAt`.
   */
  it('IRDispose.disposeAt is a [enqueueAt, appliedAt] tuple, not a scalar', () => {
    expectTypeOf<IRDispose['disposeAt']>().toEqualTypeOf<readonly [number, number]>()
    // Adversarial twin: a `number`-scalar disposeAt is a different
    // shape — assert the negative direction.
    expectTypeOf<IRDispose['disposeAt']>().not.toEqualTypeOf<number>()
    expectTypeOf<IRDispose['disposeAt']>().not.toEqualTypeOf<readonly [number, number, number]>()
  })

  /**
   * Test 4 — `IRCommit.originEvent` is `string | undefined`
   * (presence-discriminator). A commit with `originEvent` set was
   * emitted by a subscribe-callback frame; a commit without was
   * user-initiated. EPIC-2's `CommitFromSubscribe` pass keys on this.
   */
  it('IRCommit.originEvent is string | undefined (optional)', () => {
    expectTypeOf<IRCommit['originEvent']>().toEqualTypeOf<string | undefined>()
  })

  /**
   * Test 5 — `CauslModel` top-level shape is exactly seven fields:
   * `schema | time | nodes | commits | events | scopes | bridges`.
   * Wire-format byte determinism contract: every wire-format
   * expansion is reviewed; this test catches a future PR that adds a
   * field without updating the closure.
   */
  it('CauslModel top-level shape is exactly the eight fields', () => {
    // The 7-field shape was widened to 8 in #614 / wave-20, which
    // added the optional `readsTruncated?: boolean` honesty marker
    // per EPIC-1 brutal-critical review #4. The closure remains
    // tight — adding a ninth field still trips this test.
    type Keys = keyof CauslModel
    expectTypeOf<Keys>().toEqualTypeOf<
      | 'schema'
      | 'time'
      | 'nodes'
      | 'commits'
      | 'events'
      | 'scopes'
      | 'bridges'
      | 'readsTruncated'
    >()
  })

  /**
   * Test 5b — `IRScope` carries the lifecycle fields the EPIC-2
   * `SubscribeWithoutDispose` pass resolves against: `id`, `kind`
   * (one of `'ephemeral' | 'infinite' | 'process-exit'`), and
   * `lifetime: { origin, terminator }`.
   */
  it('IRScope shape has id + kind + lifetime', () => {
    expectTypeOf<IRScope['kind']>().toEqualTypeOf<
      'ephemeral' | 'infinite' | 'process-exit'
    >()
    expectTypeOf<IRScope>().toHaveProperty('id').toEqualTypeOf<string>()
    expectTypeOf<IRScope>().toHaveProperty('lifetime').toMatchTypeOf<{
      readonly origin: string
      readonly terminator: string
    }>()
  })

  /**
   * Test 5c — `IRBridge.policy` is closed at three literals so the
   * `CrossGraphRead` pass can match the wire field exhaustively.
   */
  it('IRBridge.policy is closed at three literals', () => {
    expectTypeOf<IRBridge['policy']>().toEqualTypeOf<
      'legacy-allow' | 'test-only' | 'read-only'
    >()
  })
})

// ─── Runtime fixtures (TASK 1.B1.1 tests 6-7) ─────────────────────────

describe('TASK 1.B1.1 / runtime — JSON round-trip + parseCauslModel', () => {
  /**
   * Helper — a populated schema-3 IR fixture exercising every event
   * variant, one `IRScope`, one `IRBridge { policy: "test-only" }`,
   * one `IRCommit` with `originEvent` set, and one `IRRead` with
   * `truncated: true`. Used as the round-trip golden and the
   * structural-validator positive case.
   */
  function populatedFixture(): CauslModel {
    return {
      schema: CAUSL_MODEL_SCHEMA,
      time: 5,
      nodes: [
        { kind: 'input', id: 'a', graphId: 'g.fix', value: 1, serializable: true },
        {
          kind: 'derived',
          id: 'd',
          graphId: 'g.fix',
          deps: ['a'],
          conditionalDeps: [],
          value: 1,
          serializable: true,
        },
      ],
      commits: [
        { time: 1, graphId: 'g.fix', intent: 'seed', changedNodes: ['a', 'd'] },
        // Commit with originEvent set — a CommitFromSubscribe candidate.
        {
          time: 2,
          graphId: 'g.fix',
          intent: 'mirror',
          changedNodes: ['a'],
          originEvent: 'cb.1',
        },
      ],
      events: [
        {
          kind: 'subscribe',
          graphId: 'g.fix',
          id: 's.1',
          scopeId: 'sc.modal',
          target: 'd',
          callbackSite: 'src/Modal.tsx:30:7',
          time: 1,
        },
        {
          kind: 'subscribe-callback',
          graphId: 'g.fix',
          id: 'cb.1',
          subscribeId: 's.1',
          firedAt: 2,
        },
        {
          kind: 'unsubscribe',
          graphId: 'g.fix',
          id: 's.1',
          scopeId: 'sc.modal',
          time: 4,
        },
        {
          kind: 'dispose',
          graphId: 'g.fix',
          nodeId: 'd',
          scopeId: 'sc.modal',
          time: 4,
          // Half-open interval: enqueued at 4, applied at 4 (immediate).
          disposeAt: [4, 4],
        },
        {
          kind: 'read',
          graphId: 'g.fix',
          derivedId: 'd',
          readNodeId: 'a',
          time: 3,
          seq: 0,
          truncated: true,
        },
        {
          kind: 'tx-set',
          graphId: 'g.fix',
          inputId: 'a',
          time: 2,
        },
      ],
      scopes: [
        {
          id: 'sc.modal',
          kind: 'ephemeral',
          lifetime: { origin: 'modal-open', terminator: 'modal-close' },
        },
      ],
      bridges: [
        { from: 'g.flags', to: 'g.fix', dep: 'theme', policy: 'test-only' },
      ],
    }
  }

  /**
   * Test 6 — JSON round-trip preserves every variant including the
   * half-open `disposeAt` tuple. The tuple round-trips as `[4, 4]`,
   * not `{0: 4, 1: 4}` — JSON arrays survive `parse(stringify(x))`
   * intact.
   */
  it('JSON round-trip preserves every IREvent variant byte-for-byte', () => {
    const m = populatedFixture()
    const round = JSON.parse(JSON.stringify(m)) as CauslModel
    expect(round).toEqual(m)
    // Byte-equal — same JSON string both ways.
    expect(JSON.stringify(round)).toBe(JSON.stringify(m))
  })

  it('disposeAt round-trips as a tuple, not an object', () => {
    const m = populatedFixture()
    const json = JSON.stringify(m)
    // The disposeAt field appears as `[4,4]` in the wire bytes.
    expect(json).toContain('"disposeAt":[4,4]')
    expect(json).not.toContain('"disposeAt":{')
  })

  it('every event in the fixture exercises a distinct kind', () => {
    const m = populatedFixture()
    const kinds = new Set(m.events.map((e) => e.kind))
    expect(kinds).toEqual(
      new Set([
        'subscribe',
        'subscribe-callback',
        'unsubscribe',
        'dispose',
        'read',
        'tx-set',
      ]),
    )
  })

  it('originEvent on IRCommit is an optional presence-discriminator', () => {
    const m = populatedFixture()
    const seed = m.commits.find((c) => c.intent === 'seed')!
    const mirror = m.commits.find((c) => c.intent === 'mirror')!
    expect(seed.originEvent).toBeUndefined()
    expect(mirror.originEvent).toBe('cb.1')
  })

  /**
   * Test 7a — `parseCauslModel` accepts a populated schema-3 IR with
   * every variant present.
   */
  it('parseCauslModel accepts a populated fixture', () => {
    const m = populatedFixture()
    const result = parseCauslModel(m)
    expect(result.ok).toBe(true)
  })

  /**
   * Test 7b — `parseCauslModel` rejects a schema-3 document missing
   * `bridges`. Path-precision: the error names the missing field.
   */
  it('parseCauslModel rejects a document missing bridges', () => {
    const incomplete = {
      schema: 3,
      time: 0,
      nodes: [],
      commits: [],
      events: [],
      scopes: [],
      // bridges intentionally absent
    }
    const result = parseCauslModel(incomplete)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.path).toEqual(['bridges'])
    }
  })

  it('parseCauslModel rejects a document missing scopes', () => {
    const incomplete = {
      schema: 3,
      time: 0,
      nodes: [],
      commits: [],
      events: [],
      bridges: [],
      // scopes intentionally absent
    }
    const result = parseCauslModel(incomplete)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.path).toEqual(['scopes'])
    }
  })

  it('parseCauslModel rejects an event with unknown kind', () => {
    const bad = {
      schema: 3,
      time: 0,
      nodes: [],
      commits: [],
      events: [{ kind: 'snapshot', graphId: 'g.x', time: 0 }],
      scopes: [],
      bridges: [],
    }
    const result = parseCauslModel(bad)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.path).toEqual(['events', 0, 'kind'])
    }
  })

  it('parseCauslModel rejects schema != 3', () => {
    const bad = {
      schema: 2,
      time: 0,
      nodes: [],
      commits: [],
      events: [],
      scopes: [],
      bridges: [],
    }
    const result = parseCauslModel(bad)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.path).toEqual(['schema'])
    }
  })

  it('parseCauslModel rejects an IRDispose with a malformed disposeAt scalar', () => {
    const bad = {
      schema: 3,
      time: 0,
      nodes: [],
      commits: [],
      events: [
        {
          kind: 'dispose',
          graphId: 'g.x',
          nodeId: 'n',
          scopeId: 'sc',
          time: 1,
          disposeAt: 1, // scalar instead of [number, number]
        },
      ],
      scopes: [],
      bridges: [],
    }
    const result = parseCauslModel(bad)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      // Path includes the variant index + field
      expect(result.path?.[0]).toBe('events')
      expect(result.path?.[1]).toBe(0)
      expect(result.path).toContain('disposeAt')
    }
  })
})

// ─── Backward-compat with PR-A (events: []) ───────────────────────────

describe('TASK 1.B1.1 / backward-compat — PR-A documents still parse', () => {
  /**
   * A PR-A-shaped document has `events: []`, no `scopes`, no
   * `bridges`. Schema 3 PR-B1 widens the closure; PR-A documents need
   * to round-trip through the validator if migrated to add the two
   * new top-level arrays.
   */
  it('PR-A document migrated to PR-B1 (with empty scopes/bridges) parses', () => {
    const pr_a_migrated = {
      schema: 3,
      time: 0,
      nodes: [],
      commits: [],
      events: [],
      scopes: [],
      bridges: [],
    }
    const result = parseCauslModel(pr_a_migrated)
    expect(result.ok).toBe(true)
  })
})
