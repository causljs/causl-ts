/**
 * @packageDocumentation
 *
 * Property-based fuzz pinning the #980 lazy-mint of `firedManyGroups`
 * inside `phaseG_dispatchPerNodeSubscribers`.
 *
 * Background: pre-#980 every Phase G dispatch unconditionally allocated
 * a fresh `Set<ManyGroup>()` even when no `subscribeMany` group was
 * registered. Adopters using only the canonical single-node `subscribe`
 * API paid one Set allocation per commit for nothing. #980 mirrors the
 * #915 InputEntry / #916 SubscriptionEntry lazy-mint discipline: the
 * Set materialises only on the first `subscribeMany` member observed
 * during this dispatch.
 *
 * The refactor is an internal optimisation — observable behavior must
 * remain identical to pre-#980 because the dedupe semantics for
 * `subscribeMany` groups across changed-node bucket walks are unchanged.
 * This file pins the contract:
 *
 *   1. Single-node `subscribe`-only graphs: every subscriber fires
 *      correctly across random commit sequences (the lazy Set never
 *      mints, but plain dispatch is unchanged).
 *   2. `subscribeMany` group dedupe: when multiple nodes of the same
 *      group change in one commit, the group's observer fires exactly
 *      once — the dedupe invariant holds whether the Set is lazy or
 *      eager.
 *
 * Trial budget honours the project-wide >=1000-run floor via
 * `propertyTrials`. Seeds are deterministic via `CAUSL_FUZZ_SEED` and
 * logged on failure for reproducible CI bisection.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createCausl } from '../../src/index.js'
import { propertyTrials } from '@causl/core-testing-internal'

describe('SPEC #980 — firedManyGroups lazy-mint in phaseG_dispatchPerNodeSubscribers', () => {
  /**
   * Property 1 — single-node `subscribe`-only graphs: across random
   * sequences of subscribe + commit operations, every subscriber sees
   * exactly the post-commit value of its node when (and only when)
   * that node's value actually changed. The lazy Set is never minted
   * in this scenario; if the lazy guard were buggy (e.g. the
   * `firedManyGroups !== undefined` short-circuit silently dropped
   * single-node fires), this property would catch it.
   */
  it('single-node subscribe-only: every change fires its subscriber exactly once', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 16 }),
        fc.array(
          fc.tuple(fc.nat(), fc.integer({ min: -1000, max: 1000 })),
          { minLength: 1, maxLength: 32 },
        ),
        (numInputs, writes) => {
          const graph = createCausl()
          const initial = Array.from({ length: numInputs }, (_, i) => i * 10)
          const inputs = initial.map((v, i) => graph.input(`s:${i}`, v))
          // Per-input fire counter & last-seen-value record.
          const fireCount = new Array<number>(numInputs).fill(0)
          const lastSeen = new Array<number>(numInputs).fill(NaN)
          const unsubs = inputs.map((input, i) =>
            graph.subscribe(input, (v) => {
              fireCount[i]!++
              lastSeen[i] = v as number
            }),
          )
          // subscribe fires an initial-value notification — reset
          // counters so the property measures only post-commit fan.
          for (let i = 0; i < numInputs; i++) {
            fireCount[i] = 0
            lastSeen[i] = initial[i]!
          }
          // Build oracle: walk writes, last-write-wins per input.
          const finalValues = [...initial]
          const expectedFireCount = new Array<number>(numInputs).fill(0)
          // Track per-commit unique-changed-value behavior: with a
          // single commit, an observer fires at most once per input
          // regardless of how many times tx.set is called within the
          // run() body, and only if the final staged value differs
          // from the pre-commit committed value.
          for (const [rawIdx, value] of writes) {
            const idx = rawIdx % numInputs
            finalValues[idx] = value
          }
          for (let i = 0; i < numInputs; i++) {
            if (finalValues[i] !== initial[i]) expectedFireCount[i] = 1
          }
          graph.commit('s:fan', (tx) => {
            for (const [rawIdx, value] of writes) {
              const idx = rawIdx % numInputs
              tx.set(inputs[idx]!, value)
            }
          })
          for (let i = 0; i < numInputs; i++) {
            expect(fireCount[i]).toBe(expectedFireCount[i])
            expect(lastSeen[i]).toBe(finalValues[i])
          }
          for (const unsub of unsubs) unsub()
        },
      ),
      propertyTrials('fired-many-groups-lazy/single-node-only'),
    )
  })

  /**
   * Property 2 — subscribeMany dedupe invariant: when an arbitrary
   * subset of a group's member nodes change in one commit, the
   * group's observer fires exactly ONCE. This is the load-bearing
   * dedupe contract that the `firedManyGroups` Set enforces; the
   * lazy-mint must not regress idempotency. We mix a `subscribeMany`
   * group with extra single-node subscribers so the dispatch loop
   * traverses both branches on every commit.
   */
  it('subscribeMany dedupe: group observer fires exactly once per commit regardless of how many members change', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 8 }),
        fc.uniqueArray(fc.nat({ max: 7 }), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: -100, max: 100 }),
        (numNodes, rawChangedIdxs, writeValue) => {
          const graph = createCausl()
          const initial = Array.from({ length: numNodes }, (_, i) => i * 10)
          const inputs = initial.map((v, i) => graph.input(`m:${i}`, v))
          // Group fire counter.
          let groupFireCount = 0
          const valueTuples: number[][] = []
          const unsubGroup = graph.subscribeMany(inputs, (vs) => {
            groupFireCount++
            valueTuples.push((vs as number[]).slice())
          })
          // Mix in single-node subscribers so the bucket walk also
          // traverses the `manyGroup === null` branch.
          const singleFireCount = new Array<number>(numNodes).fill(0)
          const singleUnsubs = inputs.map((input, i) =>
            graph.subscribe(input, () => {
              singleFireCount[i]!++
            }),
          )
          // Reset counters: subscribe / subscribeMany emit initial
          // notifications. The property measures only post-commit fan.
          groupFireCount = 0
          valueTuples.length = 0
          for (let i = 0; i < numNodes; i++) singleFireCount[i] = 0
          // Map changed indices into [0, numNodes) and keep only those
          // whose write actually moves the value.
          const changedIdxs = new Set<number>()
          for (const raw of rawChangedIdxs) {
            const idx = raw % numNodes
            if (initial[idx] !== writeValue) changedIdxs.add(idx)
          }
          graph.commit('m:fan', (tx) => {
            for (const idx of changedIdxs) {
              tx.set(inputs[idx]!, writeValue)
            }
          })
          if (changedIdxs.size === 0) {
            // No writes moved any value — nothing should fire.
            expect(groupFireCount).toBe(0)
          } else {
            // Group observer fires EXACTLY once regardless of how
            // many members changed: this is the dedupe invariant.
            expect(groupFireCount).toBe(1)
            // The value tuple reflects the post-commit committed
            // values for every member.
            const expectedTuple = initial.map((v, i) =>
              changedIdxs.has(i) ? writeValue : v,
            )
            expect(valueTuples[0]).toEqual(expectedTuple)
          }
          // Single-node subscribers fire once for every changed input
          // (their `manyGroup === null` so the lazy Set guard does not
          // affect them).
          for (let i = 0; i < numNodes; i++) {
            expect(singleFireCount[i]).toBe(changedIdxs.has(i) ? 1 : 0)
          }
          unsubGroup()
          for (const unsub of singleUnsubs) unsub()
        },
      ),
      propertyTrials('fired-many-groups-lazy/group-dedupe'),
    )
  })

  /**
   * Property 3 — multiple `subscribeMany` groups: when several
   * disjoint groups have members changing in the same commit, each
   * group's observer fires exactly once. The lazy Set must
   * accumulate every fired group across the bucket walks; this
   * verifies that minting on the first group does not somehow
   * shadow subsequent groups.
   */
  it('multiple subscribeMany groups: each group observer fires exactly once across mixed bucket walks', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }),
        fc.integer({ min: 2, max: 4 }),
        fc.array(fc.integer({ min: -100, max: 100 }), {
          minLength: 1,
          maxLength: 16,
        }),
        (numGroups, nodesPerGroup, writes) => {
          const graph = createCausl()
          const groups: { inputs: ReturnType<typeof graph.input<number>>[]; fireCount: number }[] =
            []
          const groupRefs: { fireCount: number }[] = []
          for (let g = 0; g < numGroups; g++) {
            const inputs = Array.from({ length: nodesPerGroup }, (_, i) =>
              graph.input(`g${g}:${i}`, g * 100 + i),
            )
            const ref = { fireCount: 0 }
            graph.subscribeMany(inputs, () => {
              ref.fireCount++
            })
            groups.push({ inputs, fireCount: 0 })
            groupRefs.push(ref)
          }
          // Reset counters post initial-fire.
          for (const ref of groupRefs) ref.fireCount = 0
          // Each "write" picks a (group, node-in-group) and a value.
          // Build an oracle of post-commit final values (last-write-
          // wins per (g,n)) so we know which groups should fire.
          const finalByGroupNode = new Map<string, number>()
          const writePlan: { g: number; n: number; value: number }[] = []
          for (let i = 0; i < writes.length; i++) {
            const value = writes[i]!
            const g = i % numGroups
            const n = (i * 7) % nodesPerGroup
            writePlan.push({ g, n, value })
            finalByGroupNode.set(`${g}:${n}`, value)
          }
          // A group fires iff at least one of its nodes' final value
          // differs from its pre-commit committed value.
          const groupsTouched = new Set<number>()
          for (const [key, finalValue] of finalByGroupNode) {
            const [gStr, nStr] = key.split(':')
            const g = Number(gStr)
            const n = Number(nStr)
            const initialValue = g * 100 + n
            if (initialValue !== finalValue) groupsTouched.add(g)
          }
          graph.commit('multi:fan', (tx) => {
            for (const { g, n, value } of writePlan) {
              tx.set(groups[g]!.inputs[n]!, value)
            }
          })
          // Every touched group fires exactly once; untouched groups
          // never fire.
          for (let g = 0; g < numGroups; g++) {
            expect(groupRefs[g]!.fireCount).toBe(groupsTouched.has(g) ? 1 : 0)
          }
        },
      ),
      propertyTrials('fired-many-groups-lazy/multi-group'),
    )
  })
})
