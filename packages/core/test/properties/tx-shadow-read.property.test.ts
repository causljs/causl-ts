/**
 * @packageDocumentation
 *
 * Property-based fuzz pinning the #995 split-staged shape's read-shadow
 * semantics.
 *
 * Background: pre-#995 the per-commit staged input writes lived in a
 * single `Map<NodeId, unknown>` doing two unrelated jobs — Phase B's
 * commit-log AND `readEntry`'s read-shadow probe during the user `tx`
 * lambda. #995 splits the structure into:
 *
 *   - `stagedWrites: Array<{ entry, value }>` — Phase B's linear,
 *     insertion-ordered commit log; walked once on publish.
 *   - `stagedShadow: Map<NodeId, number> | null` — lazily allocated
 *     index from id to row in `stagedWrites`; consulted by `readEntry`
 *     when a commit/simulate frame is staging.
 *
 * The split must preserve read-shadow semantics bit-for-bit. The
 * universally-quantified contract: for any sequence of `tx.set(in, v)`
 * + `g.read(in)` interleaves inside a single `commit` body, every
 * `g.read(in)` MUST return the most-recent staged value (i.e. the
 * value the previous `tx.set(in, …)` placed there) — and after the
 * commit settles, `g.read(in)` MUST return the same final value the
 * last in-tx `tx.set` wrote, with the engine's `Commit.changedNodes`
 * matching the oracle.
 *
 * This suite exercises both branches of the split:
 *
 *   - The `stagedShadow === null` branch (no slow-path write yet):
 *     `readEntry` falls through to the cell value.
 *   - The first slow-path write minting branch: `stagedShadow` becomes
 *     a singleton Map, `readEntry` returns the freshly-staged value.
 *   - The second-or-later write to an already-staged input: re-write
 *     updates the existing `stagedWrites[idx]` row in place;
 *     `readEntry` returns the latest value.
 *
 * Three universally-quantified properties:
 *
 *   P1. set;read interleave determinism — every `g.read(input)` inside
 *       the user lambda matches the oracle's last-write-wins value at
 *       that point in the sequence.
 *
 *   P2. Post-commit consistency — after the commit settles,
 *       `g.read(input)` for every touched input returns the final
 *       in-tx value, and `Commit.changedNodes` matches the oracle.
 *
 *   P3. Re-write idempotence — a `tx.set(in, v); tx.set(in, v)`
 *       repeat is a no-op (the second call hits the equal-value
 *       fast-path on the staged-row's value); a
 *       `tx.set(in, v0); tx.set(in, v1); tx.set(in, v0)` revert
 *       sequence ends with the input's pre-commit value (the
 *       `Object.is(e.value, v0)` cutoff in Phase B drops the row).
 *
 * Trial budget honours the project-wide ≥1000-run floor via
 * `propertyTrials`. Seeds are deterministic via `CAUSL_FUZZ_SEED`
 * and logged on failure for reproducible CI bisection.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createCausl } from '../../src/index.js'
import { propertyTrials } from '@causl/core-testing-internal'

describe('SPEC #995 — split-staged shape read-shadow semantics', () => {
  /**
   * P1 — set;read interleave determinism. Every `g.read(input)` inside
   * the user lambda returns the most-recent in-tx staged value at that
   * point in the sequence (the oracle's last-write-wins answer).
   */
  it('set;read interleaves return the most-recent staged value (oracle match)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.array(
          fc.record({
            kind: fc.constantFrom<'set' | 'read'>('set', 'read'),
            rawIdx: fc.nat(),
            value: fc.integer({ min: -1000, max: 1000 }),
          }),
          { minLength: 1, maxLength: 64 },
        ),
        (numInputs, ops) => {
          const graph = createCausl()
          // Initial values are distinct so the oracle can detect any
          // misrouting without ambiguity.
          const initials = Array.from({ length: numInputs }, (_, i) => i * 17)
          const inputs = initials.map((v, i) => graph.input(`sh:${i}`, v))
          // Force `hasDependents` to flip true so writes route through
          // the slow path that the split-staged shape governs. The
          // hasDependents fast-path (#994) bypasses staging entirely
          // and is covered by its own property suite — this test pins
          // the slow-path read-shadow contract.
          const sum = graph.derived('sum', (get) => {
            let s = 0
            for (const inp of inputs) s += get(inp)
            return s
          })
          graph.read(sum)

          // Oracle state — what the in-tx `g.read` should observe at
          // each step. Initialised to the cell values.
          const oracle = [...initials]
          const observed: { idx: number; expected: number; actual: number }[] =
            []

          graph.commit('p1', (tx) => {
            for (const op of ops) {
              const idx = op.rawIdx % numInputs
              if (op.kind === 'set') {
                tx.set(inputs[idx]!, op.value)
                oracle[idx] = op.value
              } else {
                const actual = graph.read(inputs[idx]!)
                observed.push({
                  idx,
                  expected: oracle[idx]!,
                  actual,
                })
              }
            }
          })

          for (const r of observed) {
            expect(r.actual).toBe(r.expected)
          }
        },
      ),
      propertyTrials('tx-shadow-read/interleave-determinism'),
    )
  })

  /**
   * P2 — post-commit consistency. After the commit settles,
   * `g.read(input)` returns the final in-tx value for every input that
   * actually moved, and `Commit.changedNodes` matches the oracle's set
   * of moved inputs (plus the derived if it actually moved).
   */
  it('post-commit reads see final staged value; changedNodes matches oracle', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.array(
          fc.record({
            rawIdx: fc.nat(),
            value: fc.integer({ min: -1000, max: 1000 }),
          }),
          { minLength: 0, maxLength: 64 },
        ),
        (numInputs, writes) => {
          const graph = createCausl()
          const initials = Array.from({ length: numInputs }, (_, i) => i * 23)
          const inputs = initials.map((v, i) => graph.input(`p2:${i}`, v))
          const sum = graph.derived('p2sum', (get) => {
            let s = 0
            for (const inp of inputs) s += get(inp)
            return s
          })
          graph.read(sum)

          // Oracle: last-write-wins per input.
          const finals = [...initials]
          for (const w of writes) {
            const idx = w.rawIdx % numInputs
            finals[idx] = w.value
          }

          const initialSum = initials.reduce((a, b) => a + b, 0)
          const finalSum = finals.reduce((a, b) => a + b, 0)
          const expectedChanged = new Set<string>()
          for (let i = 0; i < numInputs; i++) {
            if (!Object.is(finals[i], initials[i])) {
              expectedChanged.add(`p2:${i}`)
            }
          }
          if (expectedChanged.size > 0 && !Object.is(finalSum, initialSum)) {
            expectedChanged.add('p2sum')
          }

          const c = graph.commit('p2', (tx) => {
            for (const w of writes) {
              const idx = w.rawIdx % numInputs
              tx.set(inputs[idx]!, w.value)
            }
          })

          // Post-commit reads see the final in-tx value.
          for (let i = 0; i < numInputs; i++) {
            expect(graph.read(inputs[i]!)).toBe(finals[i])
          }

          // changedNodes matches the oracle (set equality).
          const actualChanged = new Set(c.changedNodes)
          expect(actualChanged).toEqual(expectedChanged)
        },
      ),
      propertyTrials('tx-shadow-read/post-commit-consistency'),
    )
  })

  /**
   * P3 — re-write idempotence on the split-staged shape. A
   * `tx.set(in, v0); tx.set(in, v1); tx.set(in, v0)` revert sequence
   * lands the input back at `v0` — and because Phase B's `Object.is`
   * cutoff drops rows whose staged value equals the committed cell,
   * the input is excluded from `Commit.changedNodes` if `v0` was the
   * pre-commit value. The split-staged shape's re-write path
   * (`stagedWrites[idx].value = value`) must preserve this contract
   * bit-for-bit.
   */
  it('revert-to-original is a no-op (re-write path updates stagedWrites in place)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        fc.array(
          fc.record({
            rawIdx: fc.nat(),
            v1: fc.integer({ min: -1000, max: 1000 }),
          }),
          { minLength: 1, maxLength: 16 },
        ),
        (numInputs, ops) => {
          const graph = createCausl()
          const initials = Array.from({ length: numInputs }, (_, i) => i * 29)
          const inputs = initials.map((v, i) => graph.input(`p3:${i}`, v))
          const sum = graph.derived('p3sum', (get) => {
            let s = 0
            for (const inp of inputs) s += get(inp)
            return s
          })
          graph.read(sum)

          const c = graph.commit('p3', (tx) => {
            for (const op of ops) {
              const idx = op.rawIdx % numInputs
              const original = initials[idx]!
              tx.set(inputs[idx]!, original)
              tx.set(inputs[idx]!, op.v1)
              tx.set(inputs[idx]!, original)
            }
          })

          // No input changed value — every revert sequence ended at
          // the original. The Object.is cutoff in Phase B must drop
          // every staged row, so changedNodes is empty.
          expect(c.changedNodes.length).toBe(0)
          for (let i = 0; i < numInputs; i++) {
            expect(graph.read(inputs[i]!)).toBe(initials[i])
          }
        },
      ),
      propertyTrials('tx-shadow-read/revert-to-original'),
    )
  })

  /**
   * P4 — the `stagedShadow === null` branch. When a commit body
   * issues NO slow-path `tx.set` calls (only reads), `readEntry`'s
   * shadow probe falls through to the cell value because
   * `stagedShadow` is never minted. This pins that the
   * `stagedActive`-only-but-no-shadow branch returns the pre-commit
   * cell value.
   */
  it('read-only commit body sees pre-commit cell value (stagedShadow never minted)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.array(fc.integer({ min: -1000, max: 1000 }), {
          minLength: 1,
          maxLength: 16,
        }),
        (numInputs, primingValues) => {
          const graph = createCausl()
          const inputs = Array.from({ length: numInputs }, (_, i) =>
            graph.input(`p4:${i}`, i * 31),
          )
          const sum = graph.derived('p4sum', (get) => {
            let s = 0
            for (const inp of inputs) s += get(inp)
            return s
          })
          graph.read(sum)

          // Prime each input to its priming value via prior commits.
          for (let i = 0; i < primingValues.length; i++) {
            const idx = i % numInputs
            graph.commit('prime', (tx) => {
              tx.set(inputs[idx]!, primingValues[i]!)
            })
          }

          // Capture each input's cell value after priming.
          const cellValues = inputs.map((inp) => graph.read(inp))

          // A commit body that only reads — no `tx.set` calls — must
          // see the cell values. `stagedShadow` is never minted on
          // this commit; `readEntry`'s probe falls through to
          // `e.value` even though `stagedActive === true`.
          let observed: number[] = []
          graph.commit('p4-readonly', (_tx) => {
            observed = inputs.map((inp) => graph.read(inp))
          })

          expect(observed).toEqual(cellValues)
        },
      ),
      propertyTrials('tx-shadow-read/readonly-no-shadow-mint'),
    )
  })
})
