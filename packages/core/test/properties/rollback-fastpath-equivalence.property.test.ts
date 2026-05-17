/**
 * @packageDocumentation
 *
 * **Load-bearing differential equivalence gate for #1549 Family A**
 * (the rollback single-input / single-derived fast path: H-A1 +
 * H-A2).
 *
 * #1549 H-A1 specialises `commitInternal`'s Phase B input-rollback
 * bookkeeping for the narrow shape `stagedLen === 1 && rollbackLen
 * === 0` (exactly one distinct slow-path `tx.set`, no Phase A.5
 * `#994` fast-path survivor): instead of the `length =`-grow →
 * index-fill → `length =`-trim churn on the three `inputRollback*`
 * arrays, the single row is held in three closure scalars. #1549
 * H-A2 specialises the derived-rollback `Map<NodeId, …>` for the
 * exactly-one-derived-recomputes shape: the single record lives in a
 * scalar holder slot and the Map is never minted (a second distinct
 * id promotes back to the Map).
 *
 * SPEC §3 Theorem 3 (atomicity): after a thrown commit the engine
 * state MUST be byte-identical to the pre-transaction state. A fast
 * path that is even subtly wrong silently corrupts adopter state on
 * every aborted transaction — strictly worse than being slow.
 * Therefore the fast path is a *specialisation that is equivalent by
 * construction*; this suite is the differential property gate that
 * proves it over many random trials:
 *
 *   E1. **fast ≡ pre-tx (Phase A throw).** A single-input commit
 *       whose user lambda throws AFTER `tx.set` (Phase A) — exercises
 *       H-A1's catch-arm scalar restore with NO Phase D. Post-abort
 *       `exportModel()` IR must be byte-identical to the pre-tx IR.
 *
 *   E2. **fast ≡ pre-tx (Phase D throw).** A single-input + single-
 *       derived commit where the derived throws in Phase D (after
 *       Phase B materialised the H-A1 scalar AND Phase D recorded the
 *       H-A2 scalar). Post-abort IR == pre-tx IR.
 *
 *   E3. **fast ≡ slow (differential).** The SAME random write run on
 *       (F) an engine that takes the fast path and (S) an engine
 *       structurally forced onto the UNMODIFIED general array / Map
 *       path (a second input defeats the `stagedLen === 1` H-A1
 *       gate; a second recomputing derived defeats H-A2's single
 *       slot, promoting to the Map). The shared input + shared
 *       derived must read back byte-identically between F and S on
 *       BOTH the abort arm (== each engine's own pre-tx state) AND a
 *       subsequent successful commit. fast ≡ slow, proven random.
 *
 * The general/slow path is left completely unchanged as the
 * correctness fallback; clause E3 pins that the fast path produces
 * provably-identical results to it.
 *
 * Trial floor honours the SPEC §15.2 ≥1000-run floor via
 * `propertyTrials`. Seeds deterministic via `CAUSL_FUZZ_SEED`.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createCausl } from '../../src/index.js'
import { propertyTrials } from '@causl/core-testing-internal'

/** A thrown sentinel that is distinguishable from engine errors. */
class TxAbort extends Error {
  constructor() {
    super('property-test forced tx abort')
    this.name = 'TxAbort'
  }
}

/**
 * Serialise an engine to a stable, comparable byte-identity key.
 * `exportModel()` is the canonical IR `causl-check` consumes; a
 * deterministic `JSON.stringify` of it is the project's standing
 * notion of engine byte-identity. Equality of these strings ⇒
 * byte-identical engine state for every adopter-observable surface.
 */
function irKey(model: unknown): string {
  return JSON.stringify(model)
}

describe('property: #1549 rollback fast-path differential equivalence (H-A1 + H-A2)', () => {
  /**
   * E1 — single-input commit, throw at Phase A (after `tx.set`,
   * before any derived). Exercises H-A1's scalar capture + the
   * catch-arm scalar restore with NO Phase D (the `op-commit-
   * rollback` shape). Post-abort IR must equal pre-tx IR.
   */
  it('E1: single-input Phase-A throw rolls back byte-identically to pre-tx (H-A1)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000, max: 1_000 }),
        fc.integer({ min: -1_000, max: 1_000 }),
        fc.integer({ min: -1_000, max: 1_000 }),
        (initial, settled, aborted) => {
          const g = createCausl()
          const a = g.input<number>('a', initial)
          // Settle to a known pre-tx state (also a single-input
          // commit — exercises the H-A1 no-throw arm too).
          g.commit('settle', (tx) => tx.set(a, settled))

          const preIr = irKey(g.exportModel())
          const preRead = g.read(a)
          const preNow = g.now

          expect(() =>
            g.commit('abort', (tx) => {
              tx.set(a, aborted)
              throw new TxAbort()
            }),
          ).toThrow(TxAbort)

          // SPEC §3 Theorem 3: byte-identical to pre-tx.
          expect(irKey(g.exportModel())).toBe(preIr)
          expect(g.read(a)).toBe(preRead)
          expect(g.now).toBe(preNow)

          // Engine is still live: a subsequent successful single-
          // input commit advances exactly one tick and is observable
          // (pins the scalar slot was cleared, not leaked).
          const c = g.commit('after', (tx) => tx.set(a, aborted))
          expect(c.time).toBe(preNow + 1)
          expect(g.read(a)).toBe(aborted)
        },
      ),
      propertyTrials('rollback-fastpath/E1-phase-a-throw-pre-tx-identity'),
    )
  })

  /**
   * E2 — single-input + single-derived commit, throw inside the
   * derived's compute (Phase D), AFTER Phase B materialised the H-A1
   * scalar AND Phase D recorded the H-A2 scalar (the `op-derived-
   * rollback` shape). Post-abort IR must equal pre-tx IR.
   */
  it('E2: single-derived Phase-D throw rolls back byte-identically to pre-tx (H-A1+H-A2)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000 }),
        fc.integer({ min: 1, max: 1_000 }),
        (settled, abortInput) => {
          const g = createCausl()
          const a = g.input<number>('a', settled)
          // Single derived: throws iff its input is negative (the
          // exact `op-derived-rollback` trip shape — Phase D throw).
          const d = g.derived<number>('d', (get) => {
            const v = get(a)
            if (v < 0) throw new TxAbort()
            return v * 2
          })
          // Settle (no throw — single-input commit, single derived
          // recompute: H-A1 + H-A2 scalar slots both exercised on the
          // success arm too).
          g.commit('settle', (tx) => tx.set(a, settled))
          expect(g.read(d)).toBe(settled * 2)

          const preIr = irKey(g.exportModel())
          const preA = g.read(a)
          const preD = g.read(d)
          const preNow = g.now

          // Negative write → Phase D recompute of `d` throws.
          expect(() =>
            g.commit('abort', (tx) => tx.set(a, -abortInput)),
          ).toThrow(TxAbort)

          // Byte-identical to pre-tx: input AND derived restored.
          expect(irKey(g.exportModel())).toBe(preIr)
          expect(g.read(a)).toBe(preA)
          expect(g.read(d)).toBe(preD)
          expect(g.now).toBe(preNow)

          // Engine still live + correct after the aborted Phase-D
          // throw: a valid write recomputes the derived normally.
          g.commit('recover', (tx) => tx.set(a, settled + 1))
          expect(g.read(d)).toBe((settled + 1) * 2)
        },
      ),
      propertyTrials('rollback-fastpath/E2-phase-d-throw-pre-tx-identity'),
    )
  })

  /**
   * E3 — the decisive fast ≡ slow differential. The SAME random
   * write is applied to:
   *
   *   (F) engine that NATURALLY takes the H-A1/H-A2 fast path —
   *       exactly one `tx.set` on one input, exactly one derived
   *       recompute.
   *   (S) engine STRUCTURALLY FORCED onto the unmodified general
   *       path — a SECOND input written in the same tx makes
   *       `stagedLen === 2` (H-A1 gate `stagedLen === 1` fails →
   *       array grow/fill/trim path), and a SECOND derived that also
   *       recomputes makes two distinct ids record rollback rows
   *       (H-A2 single slot promotes to the Map).
   *
   * The shared `(input, derived)` pair must read back byte-
   * identically between F and S on BOTH the abort arm (each ==
   * its own pre-tx state) AND a following successful commit. If the
   * fast path diverged from the general path by even one byte on any
   * shape, this clause fails.
   */
  it('E3: fast path ≡ unmodified slow path on the shared nodes (Phase-A and Phase-D throws)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000 }),
        fc.integer({ min: 1, max: 1_000 }),
        fc.integer({ min: 1, max: 1_000 }),
        fc.boolean(),
        (settle, abortVal, recoverVal, phaseDThrow) => {
          // -- Build two structurally-shared engines. The shared
          //    surface is `a` (input) + `d` (derived d = a*2 that
          //    throws on negative). Engine S additionally has `b`
          //    (a second input) + `e` (a second derived) so its
          //    commits provably traverse the general array / Map
          //    rollback path. We assert ONLY the shared surface.
          function buildShared() {
            const g = createCausl()
            const a = g.input<number>('a', settle)
            const d = g.derived<number>('d', (get) => {
              const v = get(a)
              if (v < 0) throw new TxAbort()
              return v * 2
            })
            return { g, a, d }
          }

          const F = buildShared()
          const S = buildShared()
          // Slow-path forcing structure on S only.
          const sb = S.g.input<number>('b', 0)
          const se = S.g.derived<number>('e', (get) => get(sb) + 1)

          // Settle both to the same shared state.
          F.g.commit('settle', (tx) => tx.set(F.a, settle))
          S.g.commit('settle', (tx) => {
            tx.set(S.a, settle)
            tx.set(sb, 1) // 2 distinct staged inputs ⇒ general path
          })
          // Sanity: shared surface agrees post-settle.
          expect(F.g.read(F.a)).toBe(S.g.read(S.a))
          expect(F.g.read(F.d)).toBe(S.g.read(S.d))
          void se

          const preF = irKey(F.g.exportModel())
          const preS = irKey(S.g.exportModel())
          const preFa = F.g.read(F.a)
          const preFd = F.g.read(F.d)
          const preSa = S.g.read(S.a)
          const preSd = S.g.read(S.d)

          // -- Aborted commit. phaseDThrow toggles the throw site:
          //    true  → negative write, derived throws in Phase D
          //            (H-A1 scalar + H-A2 scalar both live).
          //    false → positive write then a user throw (Phase A,
          //            H-A1 scalar only, no Phase D record).
          const writeVal = phaseDThrow ? -abortVal : abortVal
          expect(() =>
            F.g.commit('abort', (tx) => {
              tx.set(F.a, writeVal)
              if (!phaseDThrow) throw new TxAbort()
            }),
          ).toThrow(TxAbort)
          expect(() =>
            S.g.commit('abort', (tx) => {
              tx.set(S.a, writeVal)
              // Mirror the second-input write so S stays on the
              // general path for this commit too; revert it to a
              // distinct value so it still stages a row.
              tx.set(sb, 2)
              if (!phaseDThrow) throw new TxAbort()
            }),
          ).toThrow(TxAbort)

          // Each engine rolled back byte-identically to ITS OWN
          // pre-tx state (atomicity holds on both paths) ...
          expect(irKey(F.g.exportModel())).toBe(preF)
          expect(irKey(S.g.exportModel())).toBe(preS)
          expect(F.g.read(F.a)).toBe(preFa)
          expect(F.g.read(F.d)).toBe(preFd)
          expect(S.g.read(S.a)).toBe(preSa)
          expect(S.g.read(S.d)).toBe(preSd)
          // ... and the SHARED surface is identical fast vs slow.
          expect(F.g.read(F.a)).toBe(S.g.read(S.a))
          expect(F.g.read(F.d)).toBe(S.g.read(S.d))

          // -- A subsequent SUCCESSFUL commit must also agree fast
          //    vs slow on the shared surface (pins no stale scalar /
          //    Map slot leaked into the next commit).
          F.g.commit('recover', (tx) => tx.set(F.a, recoverVal))
          S.g.commit('recover', (tx) => {
            tx.set(S.a, recoverVal)
            tx.set(sb, 3)
          })
          expect(F.g.read(F.a)).toBe(S.g.read(S.a))
          expect(F.g.read(F.d)).toBe(S.g.read(S.d))
          expect(F.g.read(F.d)).toBe(recoverVal * 2)
          expect(F.g.now).toBe(S.g.now)
        },
      ),
      propertyTrials('rollback-fastpath/E3-fast-equals-slow-differential'),
    )
  })
})
