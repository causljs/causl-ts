/**
 * @packageDocumentation
 *
 * EPIC-1 PR-B1 / TASK 1.B1.4 — migration codemod tests.
 *
 * The codemod (`tools/migrate-ir-2-to-3.ts`) takes pre-schema-3 IR
 * documents (or schema-3 PR-A documents) and produces schema-3
 * PR-B1 documents — adds `graphId` on every node and commit; adds
 * the `events`, `scopes`, `bridges` arrays; bumps `schema` to 3.
 *
 * Wirfs-Brock's framing: the codemod is the migration story. It must
 * be idempotent (running it twice on a schema-3 file is a no-op),
 * field-preserving (no value drift), and use the same `graphId`
 * regex the engine validates at construction. A drift between the
 * runtime regex and the codemod regex is impossible by construction
 * because both consume `GRAPH_ID_REGEX` from `@causl/core`.
 */

import { describe, expect, it } from 'vitest'
import { migrateOne } from '../../../tools/migrate-ir-2-to-3.js'
import { GRAPH_ID_REGEX } from '../src/index.js'

const SEED = '0xdeadbeef' as const

describe('TASK 1.B1.4 / migrateOne — codemod', () => {
  /**
   * Test 1 — running the codemod twice on a schema-3 file is a no-op.
   * Idempotence is the property that lets adopters run the codemod
   * in CI as a "migration safety net" without worrying about double-
   * application.
   */
  it('idempotent on schema-3 PR-B1 input', () => {
    const schema3 = {
      schema: 3,
      time: 0,
      nodes: [
        { kind: 'input', id: 'a', graphId: 'g.test', value: 1, serializable: true },
      ],
      commits: [
        { time: 1, graphId: 'g.test', intent: 'seed', changedNodes: ['a'] },
      ],
      events: [],
      scopes: [],
      bridges: [],
    }
    const once = migrateOne(schema3, { graphId: 'g.test', seed: SEED })
    const twice = migrateOne(once, { graphId: 'g.test', seed: SEED })
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
  })

  /**
   * Test 2 — schema-2 → schema-3 PR-B1 preserves every value
   * verbatim. Specifically: `JSON.stringify` of every `value`,
   * `time`, `originatedAt`, `serializable` field is byte-equal
   * pre/post.
   */
  it('preserves all schema-2 fields verbatim (no value drift)', () => {
    const v2 = {
      schema: 2,
      time: 7,
      nodes: [
        {
          kind: 'input',
          id: 'a',
          value: { nested: { unicode: 'ünïcödé', arr: [1, 'two', null] } },
          serializable: true,
        },
        {
          kind: 'derived',
          id: 'd',
          deps: ['a'],
          conditionalDeps: [],
          value: 42,
          serializable: false,
        },
      ],
      commits: [
        {
          time: 1,
          intent: 'seed',
          changedNodes: ['a', 'd'],
          originatedAt: Number.MAX_SAFE_INTEGER,
        },
      ],
    }
    const out = migrateOne(v2, { graphId: 'g.test', seed: SEED })
    expect(out.schema).toBe(3)
    expect(out.time).toBe(7)
    const [n0, n1] = out.nodes
    if (!n0 || !n1) throw new Error('node count drift')
    expect(JSON.stringify(n0.value)).toBe(JSON.stringify(v2.nodes[0]!.value))
    expect(n0.serializable).toBe(true)
    expect(n1.serializable).toBe(false)
    const [c0] = out.commits
    if (!c0) throw new Error('commit count drift')
    expect(c0.time).toBe(1)
    expect(c0.intent).toBe('seed')
    expect(c0.originatedAt).toBe(Number.MAX_SAFE_INTEGER)
    expect(c0.changedNodes).toEqual(['a', 'd'])
  })

  /**
   * Test 3 — codemod's `graphId` injection uses the §16.2.1.5
   * regex. Valid graphId is accepted; invalid one throws.
   */
  it('graphId injection uses the §16.2.1.5 regex', () => {
    const v2 = {
      schema: 2,
      time: 0,
      nodes: [],
      commits: [],
    }
    const out = migrateOne(v2, { graphId: 'g.test:fixture_42', seed: SEED })
    expect(out.schema).toBe(3)
    // No nodes/commits to carry graphId; assert codemod itself didn't fail.
    expect(out.nodes).toEqual([])
    expect(out.commits).toEqual([])
  })

  it('rejects an invalid --graphId (contains a space)', () => {
    const v2 = { schema: 2, time: 0, nodes: [], commits: [] }
    expect(() => migrateOne(v2, { graphId: 'my graph', seed: SEED })).toThrow(
      /graphId/i,
    )
  })

  /**
   * Test 4 — codemod injects graphId on every node and commit. The
   * injected value matches `--graphId` (or the seeded UUID).
   */
  it('injects graphId on every node and commit', () => {
    const v2 = {
      schema: 2,
      time: 1,
      nodes: [
        { kind: 'input', id: 'a', value: 1, serializable: true },
        {
          kind: 'derived',
          id: 'd',
          deps: ['a'],
          conditionalDeps: [],
          value: 1,
          serializable: true,
        },
      ],
      commits: [{ time: 1, intent: 'seed', changedNodes: ['a'] }],
    }
    const out = migrateOne(v2, { graphId: 'g.test', seed: SEED })
    const [n0, n1] = out.nodes
    const [c0] = out.commits
    if (!n0 || !n1 || !c0) throw new Error('count drift')
    expect(n0.graphId).toBe('g.test')
    expect(n1.graphId).toBe('g.test')
    expect(c0.graphId).toBe('g.test')
  })

  /**
   * Test 5 — without an explicit `--graphId`, the codemod mints a
   * deterministic id from the seed and the result still matches the
   * regex.
   */
  it('seeded id matches GRAPH_ID_REGEX', () => {
    const v2 = {
      schema: 2,
      time: 0,
      nodes: [{ kind: 'input', id: 'a', value: 1, serializable: true }],
      commits: [],
    }
    const out = migrateOne(v2, { seed: SEED })
    const [n0] = out.nodes
    if (!n0?.graphId) throw new Error('graphId not injected')
    expect(GRAPH_ID_REGEX.test(n0.graphId)).toBe(true)
  })

  /**
   * Test 6 — the seeded path is deterministic. Two independent runs
   * with the same seed produce byte-identical output.
   */
  it('seeded path is deterministic', () => {
    const v2 = {
      schema: 2,
      time: 0,
      nodes: [
        { kind: 'input', id: 'a', value: 1, serializable: true },
        { kind: 'input', id: 'b', value: 2, serializable: true },
      ],
      commits: [],
    }
    const a = migrateOne(v2, { seed: SEED })
    const b = migrateOne(v2, { seed: SEED })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  /**
   * Test 7 — schema-3 PR-A document (events: [] but no scopes /
   * bridges) is upgraded to PR-B1 by adding the empty arrays.
   * graphId on already-tagged nodes / commits is left intact.
   */
  it('upgrades schema-3 PR-A document by adding scopes and bridges', () => {
    const pra = {
      schema: 3,
      time: 0,
      nodes: [
        { kind: 'input', id: 'a', graphId: 'g.original', value: 1, serializable: true },
      ],
      commits: [
        { time: 1, graphId: 'g.original', intent: 'seed', changedNodes: ['a'] },
      ],
      events: [],
    }
    const out = migrateOne(pra, { graphId: 'g.override-ignored', seed: SEED })
    // Existing graphId is preserved (codemod adds; does not edit).
    const [n0] = out.nodes
    const [c0] = out.commits
    if (!n0 || !c0) throw new Error('count drift')
    expect(n0.graphId).toBe('g.original')
    expect(c0.graphId).toBe('g.original')
    expect(out.scopes).toEqual([])
    expect(out.bridges).toEqual([])
    expect(out.events).toEqual([])
  })

  /**
   * Test 8 — codemod adds events: [] when absent.
   */
  it('adds events: [] when absent', () => {
    const v2 = {
      schema: 2,
      time: 0,
      nodes: [],
      commits: [],
    }
    const out = migrateOne(v2, { graphId: 'g.test', seed: SEED })
    expect(out.events).toEqual([])
  })

  /**
   * Test 9 — running the codemod on output produces byte-identical
   * output (idempotence at the file level).
   */
  it('idempotent at file level (schema-2 → schema-3 → schema-3)', () => {
    const v2 = {
      schema: 2,
      time: 1,
      nodes: [
        { kind: 'input', id: 'a', value: 'hello', serializable: true },
        {
          kind: 'derived',
          id: 'd',
          deps: ['a'],
          conditionalDeps: [],
          value: 'world',
          serializable: true,
        },
      ],
      commits: [{ time: 1, intent: 'seed', changedNodes: ['a'] }],
    }
    const once = migrateOne(v2, { graphId: 'g.test', seed: SEED })
    const twice = migrateOne(once, { graphId: 'g.test', seed: SEED })
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once))
  })

  /**
   * Test 10 — codemod is non-destructive: input object is not mutated.
   * Pure-function discipline.
   */
  it('does not mutate the input document', () => {
    const v2 = {
      schema: 2,
      time: 0,
      nodes: [{ kind: 'input', id: 'a', value: 1, serializable: true }],
      commits: [],
    }
    const before = JSON.stringify(v2)
    migrateOne(v2, { graphId: 'g.test', seed: SEED })
    expect(JSON.stringify(v2)).toBe(before)
  })
})

describe('TASK 1.B1.4 / regex parity — runtime and codemod share GRAPH_ID_REGEX', () => {
  /**
   * The brutal-critical review's recommendation: pin the regex
   * source string so a future PR that loosens it via a typo (e.g.,
   * dropping the `:` from the character class) trips here.
   */
  it('GRAPH_ID_REGEX source is exactly /^[A-Za-z0-9_.:-]{1,256}$/', () => {
    expect(GRAPH_ID_REGEX.source).toBe('^[A-Za-z0-9_.:-]{1,256}$')
    // Also pin no flags (no /i, no /g) so behavior is byte-stable.
    expect(GRAPH_ID_REGEX.flags).toBe('')
  })
})
