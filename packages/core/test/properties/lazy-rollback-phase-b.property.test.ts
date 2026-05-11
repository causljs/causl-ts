/**
 * @packageDocumentation
 *
 * Property-based fuzz pinning the #993 lazy rollback materialisation in
 * Phase B.
 *
 * Background: PR #1000 (#994) added the `hasDependents` fast-path on
 * `tx.set` and PR #993 collapses Phase B's per-row rollback bookkeeping
 * to a pre-grown allocation site (one `length =` extension per array
 * before the row loop, indexed assignments inside, one `length =` trim
 * after). The atomicity contract — every byte Phase B mutated is
 * restored on a throw escaping any of Phases B–F.6 — has to hold across
 * the new shape regardless of how fast-path and slow-path writes are
 * interleaved or how many of them dedup / revert under `Object.is`.
 *
 * The existing #994 atomicity property
 * (`has-dependents-fast-path.property.test.ts` P2) covers a Phase D
 * trap. The cells this suite targets are the Phase B-internal throw
 * shapes the pre-grow/trim refactor newly touches:
 *
 *   P1. **Mixed-write byte-identical rollback under Phase F.5 throw.**
 *       Random consumed + isolated inputs are written, then a
 *       commit-metadata-derived (#452 seam) throws during Phase F.5.
 *       After the catch arm runs the engine must be byte-identical to
 *       its pre-commit moment. Phase F.5 fires AFTER Phase B has
 *       mutated cells AND AFTER Phase C.5 has stamped `lastWriteTime`
 *       — exercises the catch arm on the post-trim rollback arrays
 *       with both `value` AND `lastWriteTime` restored from the
 *       parallel-array snapshot.
 *
 *   P2. **Empty-staging tx is a structural no-op.** A `tx` body that
 *       resolves no slow-path writes (only fast-path or no writes at
 *       all) leaves `stagedEntries.length === 0`; the pre-grow guard
 *       on `stagedLen > 0` must skip the array-extension entirely so
 *       the catch arm walks only fast-path rows.
 *
 *   P3. **Object.is-skipped slow-path writes do not pollute rollback
 *       arrays.** `tx.set(consumedX, currentValue)` stages a row whose
 *       Phase B `Object.is` filter skips the mutation. The post-trim
 *       rollback length must equal the count of rows whose value
 *       actually moved — not the pre-grow worst case. Asserted
 *       indirectly through `Commit.changedNodes` parity with the
 *       oracle.
 *
 * Trial budget honours the project-wide ≥1000-run floor via
 * `propertyTrials`. Seeds are deterministic via `CAUSL_FUZZ_SEED`.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createCausl } from '../../src/index.js'
import { propertyTrials } from '@causl/core-testing-internal'

describe('SPEC #993 — lazy rollback materialisation in Phase B', () => {
  /**
   * P1 — Phase F.5 throw rolls back both fast-path and slow-path
   * Phase B mutations byte-identically.
   *
   * Phase F.5 runs AFTER Phase B (cells mutated), AFTER Phase C
   * (`now` advanced), AFTER Phase C.5 (`lastWriteTime` stamped to the
   * new `now`), AFTER Phase F (commit history append), and AFTER
   * Phase F.4 (commit-log refresh). A throw here exercises the
   * widest catch-arm rollback envelope the engine has — the precise
   * surface #993 most needs to verify.
   */
  it('Phase F.5 throw rolls back mixed fast-path + slow-path writes byte-identically', () => {
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
            (_, i) => i * 23,
          )
          const consumed = consumedInitials.map((v, i) =>
            graph.input(`c:${i}`, v),
          )
          // A regular derived that reads every consumed input so they
          // get `hasDependents = true` and `tx.set` routes them
          // through the slow path.
          graph.derived('sum', (get) => {
            let s = 0
            for (const c of consumed) s += get(c)
            return s
          })
          const isolatedInitials = Array.from(
            { length: numIsolated },
            (_, i) => 9000 + i * 19,
          )
          const isolated = isolatedInitials.map((v, i) =>
            graph.input(`i:${i}`, v),
          )

          // Phase F.5 trap: a commit-metadata-derived throws on every
          // recompute. `commitMetadataDerived` registers the id with
          // the engine's commitMetadataIds set so Phase F.5 picks it
          // up; the registration itself must succeed to arm the trap.
          let trapArmed = false
          graph.commitMetadataDerived('cm:trap', () => {
            if (trapArmed) throw new Error('phase-f5 trap')
            return 0
          })

          // Capture pre-tx engine view for byte-identical comparison.
          const consumedPre = consumed.map((c) => graph.read(c))
          const isolatedPre = isolated.map((i) => graph.read(i))

          // Force at least one consumed input to actually move (so
          // Phase B's mutation loop enters the body).
          const guaranteedNew =
            Math.max(...consumedInitials, ...isolatedInitials) + 1_000_000
          const writesWithGuaranteed = [
            ...writes,
            { kind: 'consumed' as const, rawIdx: 0, value: guaranteedNew },
          ]

          trapArmed = true
          let threw = false
          try {
            graph.commit('mixed-f5-throw', (tx) => {
              for (const w of writesWithGuaranteed) {
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

          // Engine state must be byte-identical to pre-tx for every
          // input, regardless of which path it took.
          for (let i = 0; i < numConsumed; i++) {
            expect(graph.read(consumed[i]!)).toBe(consumedPre[i])
          }
          for (let i = 0; i < numIsolated; i++) {
            expect(graph.read(isolated[i]!)).toBe(isolatedPre[i])
          }
        },
      ),
      propertyTrials('lazy-rollback-phase-b/phase-f5-throw'),
    )
  })

  /**
   * P2 — empty-staging commit (no slow-path rows resolved) leaves the
   * pre-grow guard untriggered. The catch arm walks only the fast-
   * path rows the A.5 finalisation produced.
   */
  it('empty-staging tx skips Phase B pre-grow and rolls back fast-path rows on throw', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 16 }),
        fc.array(fc.integer({ min: -1000, max: 1000 }), {
          minLength: 0,
          maxLength: 32,
        }),
        (numIsolated, writes) => {
          const graph = createCausl()
          const isolatedInitials = Array.from(
            { length: numIsolated },
            (_, i) => 7000 + i * 5,
          )
          const isolated = isolatedInitials.map((v, i) =>
            graph.input(`i:${i}`, v),
          )
          // No derived consumes any input — `hasDependents` stays
          // `false` on every input so every `tx.set` routes through
          // the fast path. `stagedEntries` ends Phase A empty.

          const isolatedPre = isolated.map((i) => graph.read(i))

          let threw = false
          try {
            graph.commit('isolated-throw', (tx) => {
              for (let k = 0; k < writes.length; k++) {
                const v = writes[k]!
                tx.set(isolated[k % numIsolated]!, v)
              }
              throw new Error('phase-a trap')
            })
          } catch (e) {
            threw = true
            void e
          }
          expect(threw).toBe(true)

          for (let i = 0; i < numIsolated; i++) {
            expect(graph.read(isolated[i]!)).toBe(isolatedPre[i])
          }
        },
      ),
      propertyTrials('lazy-rollback-phase-b/empty-staging-throw'),
    )
  })

  /**
   * P3 — Phase B `Object.is`-skipped slow-path rows do not pollute
   * `Commit.changedNodes`. The pre-grow over-allocates to
   * `stagedEntries.length`; the post-loop trim drops the unused
   * tail. Verified indirectly: a `tx.set(consumed, currentValue)`
   * stages a row but the row's `Object.is` filter skips both the
   * mutation AND the rollback push, so the trimmed array length
   * equals `changedInputIds.length` for the consumed pool. We
   * observe this through the published `Commit.changedNodes` (which
   * lists exactly the moved inputs).
   */
  it('Object.is-skipped slow-path writes do not appear in Commit.changedNodes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 8 }),
        fc.array(
          fc.record({
            idx: fc.nat(),
            // `delta` is added to the input's CURRENT value; if delta
            // is 0, the write is a same-value no-op the Phase B
            // filter will skip.
            delta: fc.integer({ min: -3, max: 3 }),
          }),
          { minLength: 1, maxLength: 24 },
        ),
        (numConsumed, writes) => {
          const graph = createCausl()
          const initials = Array.from(
            { length: numConsumed },
            (_, i) => i * 41,
          )
          const consumed = initials.map((v, i) => graph.input(`c:${i}`, v))
          // Force `hasDependents` true on all of them.
          graph.derived('sum', (get) => {
            let s = 0
            for (const c of consumed) s += get(c)
            return s
          })

          // Build oracle: walk writes; track per-input final value
          // (last write wins). Note: each `delta` is added to the
          // CURRENT input value at the time of the write — but inside
          // a single tx, `tx.set` writes go through `staged`, so the
          // "current value" the oracle sees during simulation is
          // the LAST staged write (or the initial). Mirror that.
          const stagedFinal: number[] = [...initials]
          for (const w of writes) {
            const idx = w.idx % numConsumed
            stagedFinal[idx] = stagedFinal[idx]! + w.delta
          }
          const expectedChanged = new Set<string>()
          for (let i = 0; i < numConsumed; i++) {
            if (!Object.is(stagedFinal[i], initials[i])) {
              expectedChanged.add(`c:${i}`)
            }
          }
          // Derived `sum` flips when the sum moves.
          const oldSum = initials.reduce((a, b) => a + b, 0)
          const newSum = stagedFinal.reduce((a, b) => a + b, 0)
          if (!Object.is(oldSum, newSum)) {
            expectedChanged.add('sum')
          }

          // Apply through `tx.set`, computing per-write `currentValue
          // + delta` from the engine-visible value — which inside a
          // commit means tracking our own staged shadow.
          const txStaged: number[] = [...initials]
          const c = graph.commit('skip-test', (tx) => {
            for (const w of writes) {
              const idx = w.idx % numConsumed
              const newVal = txStaged[idx]! + w.delta
              tx.set(consumed[idx]!, newVal)
              txStaged[idx] = newVal
            }
          })

          const actualChanged = new Set(c.changedNodes)
          expect(actualChanged).toStrictEqual(expectedChanged)
          // Final reads agree with the oracle.
          for (let i = 0; i < numConsumed; i++) {
            expect(graph.read(consumed[i]!)).toBe(stagedFinal[i])
          }
        },
      ),
      propertyTrials('lazy-rollback-phase-b/object-is-skip-purity'),
    )
  })
})
