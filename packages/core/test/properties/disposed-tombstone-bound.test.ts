/**
 * @packageDocumentation
 *
 * Property suite for the disposed-tombstone bound (#251).
 *
 * The disposal channel records `(id → GraphTime)` so subsequent
 * public-surface access surfaces a typed `NodeDisposedError` rather
 * than `UnknownNodeError`. Without a bound, churn that mints fresh
 * ids each lifecycle (timestamped keys, `family(uuid())`, virtualized
 * row uuids) grows the tombstone map monotonically — an unbounded
 * retention root that the original cross-cutting review on #179
 * called out as the leak shape for long-lived processes.
 *
 * The bound landed in the engine option `disposedTombstoneCap`
 * (default 1000) under FIFO insertion-order eviction, mirroring the
 * `commitHistoryCap` ring. This suite locks three invariants:
 *
 * 1. **Bounded under unique-id churn** — for any random
 *    register/dispose sequence with fresh ids, the tombstone size
 *    never exceeds the configured cap.
 * 2. **Recent disposals surface NodeDisposedError** — within the cap
 *    window, reads against a disposed id continue to throw the typed
 *    `NodeDisposedError` (the §9.1 race-class catalogue contract).
 * 3. **Evicted disposals fall back to UnknownNodeError** — past the
 *    cap, evicted-tombstone reads throw `UnknownNodeError`, the
 *    "ring rotated" arm. The trade is structural, not implicit, so
 *    callers that branch on the tagged identity still get a typed
 *    answer either way.
 *
 * Trial budget honours the §15.2 1000-trial floor through
 * `propertyTrials('tombstone-bound')`. Random unique-id traces are
 * generated as fast-check sequences, and the oracle is the
 * `disposedTombstoneSize(graph)` accessor surfaced through
 * `@causljs/core-testing-internal` (the `@causljs/core/testing`
 * seam) for this purpose. Adapter code has no production use for the
 * size accessor — it lives behind the testing seam because the
 * underlying retention is engine-internal hygiene, not a contract
 * surface (#376).
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  createCausl,
  NodeDisposedError,
  UnknownNodeError,
} from '../../src/index.js'
import { dispose } from '../../src/internal.js'
import {
  disposedTombstoneSize,
  propertyTrials,
} from '@causljs/core-testing-internal'

describe('property: disposed-tombstone bound (#251)', () => {
  /**
   * Bounded under unique-id churn: for any random sequence of
   * `(register fresh id, dispose it)` operations, the tombstone
   * size after every step is `<= disposedTombstoneCap`. A regression
   * that drops the eviction loop in `_dispose` would let the size
   * exceed the cap on the first overflow step, and the property
   * fails with a shrunk counterexample at exactly that step.
   */
  it('disposed-tombstone size never exceeds the configured cap', () => {
    fc.assert(
      fc.property(
        // The cap-overshoot factor: how many *more* unique ids we churn
        // through than the cap itself. Anything ≥ 1 should expose a
        // missing-eviction regression on the first overflow step.
        fc.integer({ min: 1, max: 4 }),
        // The cap itself: small enough that a fast-check trial completes
        // quickly across 1000 trials, but ≥ 2 so the FIFO ring has at
        // least two slots and the head-eviction loop is exercised.
        fc.integer({ min: 2, max: 8 }),
        (overshootFactor, cap) => {
          const g = createCausl({ disposedTombstoneCap: cap })
          const total = cap * (overshootFactor + 1)
          for (let i = 0; i < total; i++) {
            // Fresh id every lifecycle — the unique-id churn shape that
            // the unbounded retention map cannot survive without the
            // ring (#251).
            const id = `churn-${i}`
            const node = g.input(id, 0)
            dispose(g, node)
            // Step-wise invariant: the bound holds after every dispose,
            // not just at the end. A bulk-evict-on-finalize bug would
            // pass the post-loop check but blow through the cap during
            // the loop.
            expect(disposedTombstoneSize(g)).toBeLessThanOrEqual(cap)
          }
          // Post-loop equality: with `cap * (overshootFactor + 1)` total
          // disposals and `overshootFactor + 1 ≥ 2`, the ring must be
          // saturated at exactly `cap` tombstones — anything less means
          // the eviction loop went too eager, anything more means it
          // didn't fire.
          expect(disposedTombstoneSize(g)).toBe(cap)
        },
      ),
      propertyTrials('tombstone-bound'),
    )
  })

  /**
   * Recently-disposed ids inside the cap window continue to surface
   * `NodeDisposedError` (not `UnknownNodeError`). A regression that
   * conflates the two — say, by always falling back to `Unknown` —
   * would fail this property at the very first iteration.
   */
  it('within the cap, disposed ids surface NodeDisposedError', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 8 }),
        (cap) => {
          const g = createCausl({ disposedTombstoneCap: cap })
          // Dispose `cap` unique ids — the ring is exactly full, no
          // evictions yet. Every id should resolve as
          // NodeDisposedError on a read.
          const disposedIds: string[] = []
          for (let i = 0; i < cap; i++) {
            const id = `recent-${i}`
            const node = g.input(id, 0)
            dispose(g, node)
            disposedIds.push(id)
          }
          for (const id of disposedIds) {
            // Reconstruct a node handle with the same id — the engine
            // tombstone is keyed on id, not on the public handle.
            expect(() => g.read({ id })).toThrow(NodeDisposedError)
            expect(() => g.read({ id })).not.toThrow(UnknownNodeError)
          }
        },
      ),
      propertyTrials('tombstone-bound-recent'),
    )
  })

  /**
   * Tombstones evicted past the cap fall back to
   * `UnknownNodeError`. This is the "ring rotated" arm of the trade
   * and pinning it makes the trade structural rather than implicit.
   * A regression that hangs onto the tombstone forever would still
   * surface `NodeDisposedError`, failing this assertion.
   */
  it('past the cap, evicted-tombstone reads throw UnknownNodeError', () => {
    fc.assert(
      fc.property(
        // Bound the cap and overshoot tightly so the property completes
        // well inside the 5s default timeout across 1000 trials. The
        // critical invariant — eviction surfaces UnknownNodeError —
        // is shape-driven, not amplitude-driven, so the smaller bounds
        // still cover the regression mode.
        fc.integer({ min: 2, max: 6 }),
        fc.integer({ min: 1, max: 3 }),
        (cap, overshootFactor) => {
          const g = createCausl({ disposedTombstoneCap: cap })
          // Dispose `cap` ids first — these are the ones we expect to
          // be evicted by the subsequent churn.
          const oldestIds: string[] = []
          for (let i = 0; i < cap; i++) {
            const id = `oldest-${i}`
            const node = g.input(id, 0)
            dispose(g, node)
            oldestIds.push(id)
          }
          // Now churn `cap * overshootFactor` more unique ids through
          // dispose — every one of those evicts one from `oldestIds`
          // in FIFO order. After `cap * overshootFactor ≥ cap` more
          // disposals, all of `oldestIds` are gone from the ring.
          for (let i = 0; i < cap * overshootFactor; i++) {
            const id = `newer-${i}`
            const node = g.input(id, 0)
            dispose(g, node)
          }
          // Each oldest id should now resolve as Unknown, not Disposed.
          for (const id of oldestIds) {
            expect(() => g.read({ id })).toThrow(UnknownNodeError)
            expect(() => g.read({ id })).not.toThrow(NodeDisposedError)
          }
        },
      ),
      propertyTrials('tombstone-bound-evicted'),
    )
  })

  /**
   * Repeated-id disposal (the React-family-helper P7 idiom — full
   * unmount + remount on the same id) does not inflate the tombstone
   * count. The same id disposed twice occupies one ring slot, not
   * two, because the engine refreshes the timestamp in place. A bug
   * that double-counts a re-disposed id would fail the bound much
   * earlier than the unique-id property would, so we lock it
   * separately.
   */
  it('re-disposing the same id keeps the ring slot count stable', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 8 }),
        fc.integer({ min: 1, max: 4 }),
        (cap, repeats) => {
          const g = createCausl({ disposedTombstoneCap: cap })
          // A small fixed pool of ids — each re-registered and
          // re-disposed `repeats` times. Even with `repeats * cap`
          // dispose() calls, the tombstone size never exceeds the
          // pool size.
          const pool = Array.from({ length: cap }, (_, i) => `pool-${i}`)
          for (let r = 0; r < repeats; r++) {
            for (const id of pool) {
              const node = g.input(id, 0)
              dispose(g, node)
            }
          }
          expect(disposedTombstoneSize(g)).toBe(cap)
        },
      ),
      propertyTrials('tombstone-bound-repeat-id'),
    )
  })
})
