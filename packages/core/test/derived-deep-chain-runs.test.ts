/**
 * @packageDocumentation
 *
 * Issue #956 — registration walker iterative gate. Pins the
 * post-#956 invariant: a 10001-deep linear chain registers cleanly,
 * the tail's value is correct, and a commit at the head propagates
 * through the chain to a subscriber on the tail.
 *
 * Pre-#956 baseline: this test surfaces
 * `DerivedRegistrationStackOverflowError` because the registration
 * walker's recursive variants (notably `computeDerived`'s recursive
 * `get` accessor lazy-upstream branch and `readEntry`'s lazy-compute
 * branch) consume one V8 stack frame per chain edge.
 *
 * Post-#956: the walker is iterative end-to-end; registration scales
 * past 10k without consuming stack frames in dep-chain depth, and the
 * typed-error class becomes a defense-in-depth surface for any
 * residual recursion (a derived whose body itself recurses outside
 * the tracker, etc.) — not the expected normal-path failure mode at
 * depth 10k.
 *
 * Architectural cross-links:
 *   - #670 / #705 / #773 retired the recursive walker on the
 *     commit-time Phase D fixpoint.
 *   - #936 / PR #943 added the typed
 *     `DerivedRegistrationStackOverflowError` gate at the public
 *     boundary so a process-killing raw `RangeError` can never
 *     escape (still useful as defense-in-depth post-#956).
 *   - #946 reverted the lazy-default trial; iterative-but-still-eager
 *     is the design point — preserves SPEC §3 / §5.1 invariants
 *     unchanged.
 */

import { describe, expect, it } from 'vitest'
import { createCausl, type Node } from '../src/index.js'

describe('SPEC #956 — registration walker iterative for deep linear chains', () => {
  /**
   * Mirror of the canonical bench fixture (`linear-chain × 10000`):
   * a single input plus 10001 deriveds, each reading the
   * immediately-upstream node and adding 1. The tail's value is the
   * input plus the chain depth.
   */
  it('registers a 10001-deep linear chain and reads the correct tail value', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    let prev: Node<number> = a
    const SCALE = 10_001
    for (let i = 0; i < SCALE; i++) {
      const upstream: Node<number> = prev
      prev = g.derived<number>(`c${i}`, (get): number => get(upstream) + 1)
    }
    // Tail value = head value + chain depth = 0 + 10001.
    expect(g.read(prev)).toBe(SCALE)
  })

  /**
   * Commit propagation through the deep chain — the post-registration
   * commit-time Phase D fixpoint must walk the same depth without
   * surfacing any error. Subscribing to the tail also exercises the
   * Phase G subscriber dispatch on a deep dirty set.
   */
  it('commit propagates through a 10001-deep chain to a tail subscriber', () => {
    const g = createCausl()
    const a = g.input('a', 0)
    let prev: Node<number> = a
    const SCALE = 10_001
    for (let i = 0; i < SCALE; i++) {
      const upstream: Node<number> = prev
      prev = g.derived<number>(`c${i}`, (get): number => get(upstream) + 1)
    }
    const tail = prev
    let lastObserved: number | undefined
    const unsub = g.subscribe(tail, (v) => {
      lastObserved = v
    })
    // The subscribe-initial fired with the registration-time value.
    expect(lastObserved).toBe(SCALE)

    g.commit('bump', (tx) => tx.set(a, 1))
    // Post-commit tail value = new head + chain depth = 1 + 10001.
    expect(g.read(tail)).toBe(SCALE + 1)
    expect(lastObserved).toBe(SCALE + 1)

    unsub()
  })
})
