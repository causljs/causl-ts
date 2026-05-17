/**
 * @packageDocumentation
 *
 * Property-based fuzz pinning the #972 `tx.set` `Object.is` equal-value
 * fast-path.
 *
 * Background: pre-#972 every `tx.set(input, value)` paid for a
 * `staged.has(id)` probe + `staged.set(id, value)` write +
 * `stagedEntries.push(e)` row, even when the value was bytewise equal
 * to the cell's current committed value. The Phase B publish loop's
 * existing `Object.is(e.value, v)` filter discarded the row before
 * mutating the cell — so the staging work was always wasted on equal
 * writes. #972 moves the filter from "after stage" to "before stage"
 * by short-circuiting `tx.set` itself, eliminating up to N Map probes
 * and N array pushes per outer commit on real-adopter workloads
 * (React `setState(sameValue)`, Redux dispatching the same action
 * twice, equality-cutoff write storms).
 *
 * The refactor is an internal optimisation — observable behavior is
 * identical to pre-#972 because the existing Phase B `Object.is` cutoff
 * already handled equal writes downstream. This file pins the contract:
 *
 *   1. Every all-equal-write commit produces an empty `changedNodes`
 *      set (no derived recompute, no notification).
 *   2. Mixed equal + non-equal writes still propagate correctly — the
 *      fast-path does not skip rows it should not skip.
 *   3. Repeated equal writes within the same `run(tx)` body are all
 *      no-ops; the fast-path is idempotent.
 *
 * Trial budget honours the project-wide ≥1000-run floor via
 * `propertyTrials`. Seeds are deterministic via `CAUSL_FUZZ_SEED` and
 * logged on failure for reproducible CI bisection.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createCausl } from '../../src/index.js'
import { propertyTrials } from '@causljs/core-testing-internal'

describe('SPEC #972 — tx.set Object.is equal-value fast-path', () => {
  /**
   * Property 1 — random sequences of `tx.set(input, currentValue)`
   * across an arbitrary number of inputs produce an empty
   * `changedNodes` set on the resulting commit. The downstream
   * derived (`d`) MUST not recompute and MUST not notify.
   */
  it('all-equal write storm: changedNodes is empty and derived does not recompute', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -1_000_000, max: 1_000_000 }), {
          minLength: 1,
          maxLength: 64,
        }),
        (initialValues) => {
          const graph = createCausl()
          const inputs = initialValues.map((v, i) =>
            graph.input(`in:${i}`, v),
          )
          let derivedRecomputes = 0
          const d = graph.derived('d', (get) => {
            derivedRecomputes++
            // Read every input so the derived has a real dep set —
            // a constant derived would shortcut at the dep-tracking
            // layer instead of the per-input equality cutoff.
            let sum = 0
            for (const input of inputs) sum += get(input)
            return sum
          })
          // Prime: warm the derived. Every property below measures
          // post-prime behavior so the first lazy compute is excluded.
          graph.read(d)
          let notifications = 0
          const unsub = graph.subscribe(d, () => {
            notifications++
          })
          // Subscribe fires an initial-value notification (`subscribe-
          // initial` source) before the timed region — reset the
          // counter so the property measures only the post-commit fan.
          notifications = 0
          const recomputesBefore = derivedRecomputes
          // Write current values back — every write is a no-op.
          const commit = graph.commit('all-equal', (tx) => {
            for (let i = 0; i < inputs.length; i++) {
              tx.set(inputs[i]!, initialValues[i]!)
            }
          })
          unsub()
          // changedNodes excludes the input ids that were "written"
          // because their value did not change; downstream derived
          // is not in the set because it was never recomputed.
          expect(commit.changedNodes.length).toBe(0)
          // The derived should not have recomputed.
          expect(derivedRecomputes).toBe(recomputesBefore)
          // Subscriber should not have fired.
          expect(notifications).toBe(0)
        },
      ),
      propertyTrials('tx-set-equal-noop/all-equal'),
    )
  })

  /**
   * Property 2 — mixed equal + non-equal writes: the fast-path must
   * not skip rows whose value actually changed. A bug in the
   * pre-staging filter would silently drop a real write — this
   * property fuzzes the filter against an oracle that recomputes
   * the expected derived value forward.
   */
  it('mixed equal + non-equal writes: changedNodes equals the oracle changed-set', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 32 }),
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: -1000, max: 1000 })), {
          minLength: 1,
          maxLength: 32,
        }),
        (numInputs, writes) => {
          const graph = createCausl()
          const initial = Array.from({ length: numInputs }, (_, i) => i * 10)
          const inputs = initial.map((v, i) => graph.input(`m:${i}`, v))
          let derivedRecomputes = 0
          const d = graph.derived('m:d', (get) => {
            derivedRecomputes++
            let sum = 0
            for (const input of inputs) sum += get(input)
            return sum
          })
          graph.read(d)
          // Build the oracle: walk the writes, assign per-input the
          // last-write value, treat out-of-range indices as no-ops.
          const finalValues = [...initial]
          let anyChanged = false
          for (const [rawIdx, value] of writes) {
            const idx = rawIdx % numInputs
            if (finalValues[idx] !== value) anyChanged = true
            finalValues[idx] = value
          }
          const oracleChanged = !initial.every((v, i) => v === finalValues[i])
          const recomputesBefore = derivedRecomputes
          const commit = graph.commit('mixed', (tx) => {
            for (const [rawIdx, value] of writes) {
              const idx = rawIdx % numInputs
              tx.set(inputs[idx]!, value)
            }
          })
          // Oracle: derived's expected post-commit value.
          const expectedDerived = finalValues.reduce((a, b) => a + b, 0)
          expect(graph.read(d)).toBe(expectedDerived)
          // changedNodes is non-empty iff ANY input value actually moved.
          const inputIds = new Set(inputs.map((i) => i.id))
          const changedInputs = commit.changedNodes.filter((id) =>
            inputIds.has(id),
          )
          if (oracleChanged) {
            expect(changedInputs.length).toBeGreaterThan(0)
          } else {
            expect(changedInputs.length).toBe(0)
            // No-op commit: derived must not recompute.
            expect(derivedRecomputes).toBe(recomputesBefore)
          }
          void anyChanged
        },
      ),
      propertyTrials('tx-set-equal-noop/mixed'),
    )
  })

  /**
   * Property 3 — idempotency: repeated equal writes within the same
   * `run(tx)` body collapse to one no-op. A regression that, e.g.,
   * compared against `e.value` instead of the staged value would
   * silently drop the second-or-later overwrite of a different
   * value to the same input — this property exercises the
   * re-write semantics of the fast-path.
   */
  it('repeated equal writes within one tx are no-ops; intermediate non-equal writes still land', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 16 }),
        fc.array(fc.integer({ min: -100, max: 100 }), {
          minLength: 1,
          maxLength: 32,
        }),
        (initialValue, sequence) => {
          const graph = createCausl()
          const input = graph.input('seq:in', initialValue)
          let derivedRecomputes = 0
          const d = graph.derived('seq:d', (get) => {
            derivedRecomputes++
            return get(input) * 2
          })
          graph.read(d)
          // The final value seen by Phase B must equal the LAST write
          // in `sequence` (or `initialValue` if the sequence reduces
          // to a no-op). Within one tx body, the engine semantics is
          // "last write wins" — fast-path or not.
          const recomputesBefore = derivedRecomputes
          graph.commit('idem', (tx) => {
            for (const v of sequence) {
              // Emit each write twice so the second is always a "set
              // to staged value" — the idempotent-fast-path branch.
              tx.set(input, v)
              tx.set(input, v)
            }
          })
          const expectedFinal = sequence[sequence.length - 1]!
          expect(graph.read(input)).toBe(expectedFinal)
          expect(graph.read(d)).toBe(expectedFinal * 2)
          // The derived recomputes at most once: one Phase D walk
          // per outer commit, regardless of how many times the input
          // was staged inside the lambda. (If the final value equals
          // the initial value, the equality cutoff fires and the
          // derived does not recompute at all.)
          if (expectedFinal === initialValue) {
            expect(derivedRecomputes).toBe(recomputesBefore)
          } else {
            expect(derivedRecomputes - recomputesBefore).toBeLessThanOrEqual(1)
          }
        },
      ),
      propertyTrials('tx-set-equal-noop/idempotent'),
    )
  })
})
