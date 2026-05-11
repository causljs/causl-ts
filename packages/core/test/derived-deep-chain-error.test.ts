/**
 * @packageDocumentation
 *
 * Behavioural pin for #936: a deep-chain registration must NEVER
 * surface V8's raw `RangeError: Maximum call stack size exceeded`
 * across the public `graph.derived(...)` boundary. If the engine's
 * closure-tracking walker exhausts the V8 stack, it must convert to
 * the typed {@link DerivedRegistrationStackOverflowError} so adopters
 * can `instanceof CauslError` (or the narrower subclass) and degrade
 * gracefully — symmetric with the comparator harnesses (jotai #922,
 * mobx #798, redux #926) that gate the same shape upfront with their
 * `RecursiveEvalStackOverflowError`.
 *
 * The failure mode this test guards is the user-explicit invariant
 * "no public causl API ever crashes the Node process with a raw V8
 * `RangeError`" — the bench-harness gate (`packages/bench/src/
 * libraries/causl.ts` post-#936) is the comparator-symmetric DX, and
 * this engine-side conversion is the defensive boundary at the public
 * API.
 *
 * Architectural note: #670 / #705 / #773 retired the recursive walker
 * on the commit-time Phase D fixpoint (the `computeDerivedIterative`
 * driver replaced it for registration), but the post-compute
 * dep-edge reconciliation and any user-compute that calls `read`
 * outside its tracked `get` still consume V8 frames per edge. The
 * eventual structural fix is lazy registration (program retro
 * findings 1+4 — defer eager compute until first read so the
 * iterative driver becomes the only driver); until then the typed-
 * conversion guard at the registration boundary is the contract.
 */

import { describe, expect, it } from 'vitest'
import {
  CauslError,
  createCausl,
  DerivedRegistrationStackOverflowError,
  type Node,
} from '../src/index.js'

describe('SPEC #936 — DerivedRegistrationStackOverflowError typed gate', () => {
  describe('typed-error class shape', () => {
    /**
     * The error class must be a `CauslError` subclass (so the existing
     * `instanceof CauslError` branch in adopter code captures it
     * alongside other engine-emitted failures), carry the
     * discriminated `kind` field for exhaustive switching, and pin the
     * `name` discriminant so error reporters that serialise via JSON
     * (`{ name, message }`) round-trip unambiguously.
     */
    it('extends CauslError with a discriminant and name', () => {
      const err = new DerivedRegistrationStackOverflowError('c-deep', 10001)
      expect(err).toBeInstanceOf(CauslError)
      expect(err).toBeInstanceOf(Error)
      expect(err.name).toBe('DerivedRegistrationStackOverflowError')
      expect(err.kind).toBe('DerivedRegistrationStackOverflow')
      expect(err.id).toBe('c-deep')
      expect(err.scale).toBe(10001)
      expect(err.message).toContain('c-deep')
      expect(err.message).toContain('10001')
      expect(err.message).toContain('#936')
    })

    /**
     * The `scale` parameter is optional — when the conversion site
     * cannot cheaply derive the chain depth, the error still carries
     * a stable shape with `-1` and a message that omits the depth
     * fragment (rather than printing "≥ -1" which would confuse
     * adopters).
     */
    it('handles missing scale via the -1 sentinel', () => {
      const err = new DerivedRegistrationStackOverflowError('c-tail')
      expect(err.scale).toBe(-1)
      expect(err.message).not.toContain('-1')
      expect(err.message).toContain('c-tail')
    })
  })

  describe('public-API contract — no raw RangeError escapes', () => {
    /**
     * The contract: a 10001-deep linear chain must NOT surface V8's
     * raw `RangeError: Maximum call stack size exceeded` from the
     * public `graph.derived(...)` boundary. After #670's iterative
     * driver, registration at this scale completes cleanly on Node
     * 22+; the test pins both halves of the invariant — either the
     * registration succeeds (the steady-state today), or, if a
     * tighter `--stack-size` configuration drives the recursive post-
     * compute path into overflow, the engine converts to the typed
     * error. Raw `RangeError` is the only outcome the user-explicit
     * invariant forbids.
     *
     * The chain is canonically shaped to mirror the bench's
     * `linear-chain × 10000` cell (a single input + 10001 deriveds,
     * each reading the previous one) so a regression that re-
     * introduces the raw `RangeError` against the bench harness is
     * caught by the unit suite first, ahead of the bench gate.
     */
    it('a 10001-deep linear chain does not throw a raw RangeError', () => {
      const g = createCausl()
      const a = g.input('a', 0)
      let prev: Node<number> = a
      const SCALE = 10_001
      let caught: unknown
      try {
        for (let i = 0; i < SCALE; i++) {
          // Capture `prev` per-iteration so each compute closes over
          // the immediately-upstream node — the canonical chain shape.
          const upstream: Node<number> = prev
          const next: Node<number> = g.derived<number>(
            `c${i}`,
            (get): number => get(upstream) + 1,
          )
          prev = next
        }
      } catch (e) {
        caught = e
      }

      // The user-explicit invariant: no raw V8 RangeError ever
      // escapes a public API. If the engine overflows internally it
      // must convert to the typed error; if it does not overflow
      // (the steady-state on Node 22+ thanks to #670's iterative
      // driver), the registration completes and `caught` is
      // undefined. Either is acceptable; raw `RangeError` is not.
      if (caught !== undefined) {
        expect(caught).not.toBeInstanceOf(RangeError)
        expect(caught).toBeInstanceOf(DerivedRegistrationStackOverflowError)
      }
    })

    /**
     * Symmetric pin from the read side — the bench harness `step()`
     * subscribes to the chain tail and bumps the head. A 10001-deep
     * chain that *does* register must not surface a raw
     * `RangeError` from the read / commit path either; if a
     * recursive walker downstream of registration ever overflows,
     * the engine converts (or the operation completes — same
     * either-or as the registration test above).
     */
    it('subscribe + commit on a 10001-deep chain does not throw a raw RangeError', () => {
      const g = createCausl()
      const a = g.input('a', 0)
      let prev: Node<number> = a
      const SCALE = 10_001
      for (let i = 0; i < SCALE; i++) {
        const upstream: Node<number> = prev
        prev = g.derived<number>(`c${i}`, (get): number => get(upstream) + 1)
      }
      const unsub = g.subscribe(prev, () => {})
      let caught: unknown
      try {
        g.commit('bump', (tx) => tx.set(a, 1))
      } catch (e) {
        caught = e
      }
      unsub()
      if (caught !== undefined) {
        expect(caught).not.toBeInstanceOf(RangeError)
        // The conversion target is `CauslError` — the engine may
        // surface a different subclass for a deeper read-path
        // overflow than the registration class, so we widen to the
        // root tagged identity for this pin.
        expect(caught).toBeInstanceOf(CauslError)
      }
    })
  })
})
