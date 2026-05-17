/**
 * @packageDocumentation
 *
 * Property-based fuzz pinning the #994 `hasDependents` fast-path on
 * `InputEntry`.
 *
 * Background: the #882 / #972 `tx.set` body resolves the entry, dedups
 * via `staged.has`, and pushes a parallel rollback row per write — the
 * full per-commit bookkeeping the slow path needs to drive Phase B
 * publish, Phase D recompute, and the catch-arm rollback. For an input
 * that NO derivation reads, every byte of that bookkeeping is dead
 * work: Phase D's affected-subgraph walk seeds from `changedInputIds`
 * and expands through `dependents.get(id)`, which is empty for the
 * isolated input. #994 caches the predicate as `InputEntry.hasDependents`
 * and lets `tx.set` route writes around the staged Map when it's
 * `false`, while still pushing rollback rows so a *different* slow-path
 * write's Phase D throw can restore the engine byte-identically.
 *
 * The fast-path's correctness commitment to consumers of `Commit` is
 * the same as the slow-path's: `Commit.changedNodes` lists every input
 * (and every derived) whose value moved on this commit, no others
 * (#987 / PR #990). Fast-path-eligible inputs are mixed freely with
 * slow-path-eligible ones in the same `tx.set` storm; this property
 * suite asserts the published `changedNodes` matches the oracle for
 * any random mixture.
 *
 * Three universally-quantified contracts:
 *
 *   P1. Random graph with isolated AND consumed inputs. Random write
 *       sequence across both kinds. `Commit.changedNodes` equals the
 *       oracle: union of (no-consumer inputs whose final value differs
 *       from pre-tx) AND (consumed inputs whose final value differs
 *       from pre-tx) AND (every transitively-affected derived).
 *
 *   P2. Atomicity on throw: a Phase D throw escaping a *consumed*
 *       derived's compute rolls back BOTH slow-path AND fast-path
 *       writes byte-identically. After the throw the engine state is
 *       indistinguishable from the pre-commit moment.
 *
 *   P3. Revert-to-original on isolated inputs is a no-op:
 *       `tx.set(X, v0); tx.set(X, v1); tx.set(X, v0)` against an
 *       isolated input ends with `Commit.changedNodes` excluding X
 *       (the slow-path's `staged.has + Object.is` revert semantics
 *       must apply identically on the fast path).
 *
 * Trial budget honours the project-wide ≥1000-run floor via
 * `propertyTrials`. Seeds are deterministic via `CAUSL_FUZZ_SEED` and
 * logged on failure for reproducible CI bisection.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createCausl } from '../../src/index.js'
import { propertyTrials } from '@causl/core-testing-internal'

describe('SPEC #994 — hasDependents fast-path on InputEntry', () => {
  /**
   * P1 — mixed isolated + consumed input writes produce correct
   * `Commit.changedNodes`.
   *
   * Generator shape:
   *   - `numConsumed`: 1..8 inputs feeding one summing derived `d`.
   *   - `numIsolated`: 0..16 inputs with no derived consumer.
   *   - `writes`: arbitrary sequence of `{ kind, idx, value }` writes,
   *     where `kind = 'consumed' | 'isolated'` and `idx` indexes into
   *     the matching pool.
   *
   * Oracle (independent of engine):
   *   - Walk `writes` to build the per-input final value (last-write-
   *     wins).
   *   - `expectedChangedConsumed` = subset of consumed inputs whose
   *     final value differs from initial.
   *   - `expectedChangedIsolated` = subset of isolated inputs whose
   *     final value differs from initial.
   *   - `expectedDerived` = the derived id IFF
   *     `expectedChangedConsumed.size > 0` AND the new sum differs
   *     from the old sum.
   *
   * Assertion: `Commit.changedNodes` (as a Set) equals the union of
   * the three oracle sets.
   */
  it('mixed isolated + consumed writes — Commit.changedNodes matches oracle', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 0, max: 16 }),
        fc.array(
          fc.record({
            kind: fc.constantFrom<'consumed' | 'isolated'>(
              'consumed',
              'isolated',
            ),
            rawIdx: fc.nat(),
            value: fc.integer({ min: -1000, max: 1000 }),
          }),
          { minLength: 0, maxLength: 64 },
        ),
        (numConsumed, numIsolated, writes) => {
          const graph = createCausl()
          // Consumed inputs feed a summing derived. Their initial
          // values are `i * 7` so all distinct.
          const consumedInitials = Array.from(
            { length: numConsumed },
            (_, i) => i * 7,
          )
          const consumed = consumedInitials.map((v, i) =>
            graph.input(`c:${i}`, v),
          )
          const sum = graph.derived('sum', (get) => {
            let s = 0
            for (const c of consumed) s += get(c)
            return s
          })
          // Force the derived to register its read-set so
          // `hasDependents` flips to `true` on the consumed inputs.
          graph.read(sum)

          // Isolated inputs have NO derived consumer; their
          // `hasDependents` stays `false` and `tx.set` routes through
          // the fast path.
          const isolatedInitials = Array.from(
            { length: numIsolated },
            (_, i) => 1000 + i * 11,
          )
          const isolated = isolatedInitials.map((v, i) =>
            graph.input(`i:${i}`, v),
          )

          // Build oracle: walk writes forward, last-write-wins.
          const consumedFinal = [...consumedInitials]
          const isolatedFinal = [...isolatedInitials]
          for (const w of writes) {
            if (w.kind === 'consumed' && numConsumed > 0) {
              const idx = w.rawIdx % numConsumed
              consumedFinal[idx] = w.value
            } else if (w.kind === 'isolated' && numIsolated > 0) {
              const idx = w.rawIdx % numIsolated
              isolatedFinal[idx] = w.value
            }
          }

          const expectedChanged = new Set<string>()
          for (let i = 0; i < numConsumed; i++) {
            if (!Object.is(consumedFinal[i], consumedInitials[i])) {
              expectedChanged.add(`c:${i}`)
            }
          }
          for (let i = 0; i < numIsolated; i++) {
            if (!Object.is(isolatedFinal[i], isolatedInitials[i])) {
              expectedChanged.add(`i:${i}`)
            }
          }
          // Derived `sum` is in `changedNodes` iff its computed value
          // moved.
          const oldSum = consumedInitials.reduce((a, b) => a + b, 0)
          const newSum = consumedFinal.reduce((a, b) => a + b, 0)
          if (!Object.is(oldSum, newSum)) {
            expectedChanged.add('sum')
          }

          // Apply the writes through `tx.set`.
          const c = graph.commit('mixed', (tx) => {
            for (const w of writes) {
              if (w.kind === 'consumed' && numConsumed > 0) {
                const idx = w.rawIdx % numConsumed
                tx.set(consumed[idx]!, w.value)
              } else if (w.kind === 'isolated' && numIsolated > 0) {
                const idx = w.rawIdx % numIsolated
                tx.set(isolated[idx]!, w.value)
              }
            }
          })

          const actual = new Set(c.changedNodes)
          expect(actual).toStrictEqual(expectedChanged)
          // Spot-check: every isolated input's read returns the
          // last-write value (proves the fast path's read-shadow
          // path is honored — isolated inputs read `e.value`
          // directly, since `staged.has` would miss).
          for (let i = 0; i < numIsolated; i++) {
            expect(graph.read(isolated[i]!)).toBe(isolatedFinal[i])
          }
          // And the same for consumed inputs.
          for (let i = 0; i < numConsumed; i++) {
            expect(graph.read(consumed[i]!)).toBe(consumedFinal[i])
          }
          // And the summing derived agrees.
          expect(graph.read(sum)).toBe(newSum)
        },
      ),
      propertyTrials('hasDependents-fast-path/mixed-changedNodes'),
    )
  })

  /**
   * P2 — atomicity rollback covers BOTH slow-path AND fast-path
   * writes.
   *
   * A throw escaping a Phase D recompute rolls back every byte the
   * commit pipeline mutated. The fast path skips the staged Map but
   * pushes rollback rows; the catch-arm restore walks them
   * uniformly with the slow-path rows. This property fuzzes the
   * shape: random isolated + consumed writes inside a `tx.run` where
   * the consumed-input derivation throws on every recompute.
   *
   * Post-throw: every input's value equals its pre-commit value,
   * regardless of which write path it took.
   */
  it('throw escaping Phase D rolls back both slow-path and fast-path writes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 8 }),
        fc.array(
          fc.record({
            kind: fc.constantFrom<'consumed' | 'isolated'>(
              'consumed',
              'isolated',
            ),
            rawIdx: fc.nat(),
            value: fc.integer({ min: -1000, max: 1000 }),
          }),
          { minLength: 1, maxLength: 32 },
        ),
        (numConsumed, numIsolated, writes) => {
          const graph = createCausl()
          const consumedInitials = Array.from(
            { length: numConsumed },
            (_, i) => i * 13,
          )
          const consumed = consumedInitials.map((v, i) =>
            graph.input(`c:${i}`, v),
          )
          // The derived throws unconditionally on recompute. (Its
          // first read happens at registration; we register AFTER
          // capturing initials so the registration evaluates without
          // exception by short-circuiting on a flag.)
          let trapArmed = false
          graph.derived('throwy', (get) => {
            // Read every consumed input so this derived registers
            // dependence on all of them — `hasDependents` flips
            // `true` on each.
            let s = 0
            for (const c of consumed) s += get(c)
            if (trapArmed) {
              throw new Error('phase-d trap')
            }
            return s
          })
          const isolatedInitials = Array.from(
            { length: numIsolated },
            (_, i) => 5000 + i * 17,
          )
          const isolated = isolatedInitials.map((v, i) =>
            graph.input(`i:${i}`, v),
          )
          // Capture pre-tx engine view for byte-identical comparison.
          const consumedPre = consumed.map((c) => graph.read(c))
          const isolatedPre = isolated.map((i) => graph.read(i))

          // Now arm the trap and submit a tx that writes to both
          // pools AND guarantees Phase D fires by appending a final
          // consumed write whose value is bytewise different from
          // every initial value. Without this terminal write a
          // revert sequence (`set(c, v); set(c, original)`) would
          // dedupe at the slow-path `staged` Map and Phase D would
          // not recompute — making "throw expected" the wrong
          // oracle. The test is exercising rollback fidelity, not
          // change detection; a guaranteed real change keeps the
          // throw path live.
          const guaranteedNew =
            Math.max(...consumedInitials, ...isolatedInitials) + 1_000_000
          const writesWithConsumed = [
            ...writes,
            { kind: 'consumed' as const, rawIdx: 0, value: guaranteedNew },
          ]
          trapArmed = true
          let threw = false
          try {
            graph.commit('mixed-throw', (tx) => {
              for (const w of writesWithConsumed) {
                if (w.kind === 'consumed') {
                  const idx = w.rawIdx % numConsumed
                  tx.set(consumed[idx]!, w.value)
                } else {
                  const idx = w.rawIdx % numIsolated
                  tx.set(isolated[idx]!, w.value)
                }
              }
            })
          } catch (e) {
            threw = true
            void e
          }
          expect(threw).toBe(true)

          // Engine state must be byte-identical to pre-tx.
          for (let i = 0; i < numConsumed; i++) {
            expect(graph.read(consumed[i]!)).toBe(consumedPre[i])
          }
          for (let i = 0; i < numIsolated; i++) {
            expect(graph.read(isolated[i]!)).toBe(isolatedPre[i])
          }
        },
      ),
      propertyTrials('hasDependents-fast-path/atomicity-rollback'),
    )
  })

  /**
   * P3 — revert-to-original on an isolated input is a no-op.
   *
   * The slow path filters revert sequences via `staged.has + Object.is`;
   * the fast path filters them via the Phase A.5 finalisation walk
   * (`Object.is(e.value, priorValue)` after the lambda completes).
   * Both must produce the same `Commit.changedNodes` shape: X is
   * NOT included when the final value equals the pre-tx value.
   *
   * Sequence shape: arbitrary writes ending with a write of the
   * original value. The oracle: X is excluded iff the final write's
   * value equals the initial value.
   */
  it('revert-to-original on isolated input excludes it from Commit.changedNodes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1000, max: 1000 }),
        fc.array(fc.integer({ min: -1000, max: 1000 }), {
          minLength: 1,
          maxLength: 16,
        }),
        fc.boolean(),
        (initial, intermediates, endsAtOriginal) => {
          const graph = createCausl()
          const x = graph.input('x', initial)
          // No derived reads `x` — `hasDependents` stays `false`.
          // (We register an unrelated derived so the engine has a
          // non-trivial graph; this derived reads a different
          // input.)
          const other = graph.input('other', 0)
          graph.derived('unrelated', (get) => get(other) * 2)

          // Build write sequence: intermediates then optionally
          // revert to initial.
          const sequence = [...intermediates]
          if (endsAtOriginal) {
            sequence.push(initial)
          }
          const finalValue = sequence[sequence.length - 1]!

          const c = graph.commit('revert-test', (tx) => {
            for (const v of sequence) tx.set(x, v)
          })

          const expectedIncluded = !Object.is(finalValue, initial)
          if (expectedIncluded) {
            expect(c.changedNodes).toContain('x')
            expect(graph.read(x)).toBe(finalValue)
          } else {
            expect(c.changedNodes).not.toContain('x')
            expect(graph.read(x)).toBe(initial)
          }
          // The unrelated derived never participates: its compute
          // is not in `changedNodes` because `other` was never
          // written.
          expect(c.changedNodes).not.toContain('unrelated')
          expect(c.changedNodes).not.toContain('other')
        },
      ),
      propertyTrials('hasDependents-fast-path/revert-noop'),
    )
  })
})
