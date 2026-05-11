/**
 * @packageDocumentation
 *
 * Runtime tests for the typed `Msg` discriminated-union helper
 * (closes #369). The compile-time exhaustiveness gates live in
 * `test-d/msg.exhaustiveness.test-d.ts`; this suite covers the
 * runtime shape: variant constructors return the right `kind`,
 * payload spread is structural, the phantom `_union` field is
 * `undefined`, the helper composes with `createUpdate` end-to-end,
 * and `assertNever` throws when reached via a typing escape hatch.
 */

import { createCausl } from '@causl/core'
import { describe, expect, it } from 'vitest'
import {
  assertNever,
  createUpdate,
  defineMsgs,
  payload,
  type MsgOf,
  type Update,
} from '../src/index.js'

/**
 * Suite covering the runtime contract of {@link defineMsgs} and the
 * {@link assertNever} probe. Each test exercises one piece of the
 * helper's public surface in isolation, then a final integration
 * test wires the helper through `createUpdate` to confirm the §8
 * MVU loop actually advances a graph when driven by helper-built
 * variants.
 */
describe('defineMsgs (typed Msg helper, #369)', () => {
  /**
   * No-payload variants are zero-arg constructors that return only
   * the `kind` discriminator. The runtime shape must match the
   * compile-time `Msg<K>` so a hand-rolled `switch (msg.kind)` works
   * without further narrowing.
   */
  it('builds zero-arg constructors for null-payload variants', () => {
    const msg = defineMsgs({
      inc: null,
      dec: null,
    })
    expect(msg.inc()).toEqual({ kind: 'inc' })
    expect(msg.dec()).toEqual({ kind: 'dec' })
  })

  /**
   * Payload variants spread the user-supplied object after the
   * `kind` tag. The tag is authoritative — even a payload object
   * carrying a stray `kind` cannot override the variant's own tag.
   */
  it('builds payload-aware constructors that spread the payload', () => {
    const msg = defineMsgs({
      set: payload<{ value: number }>(),
      label: payload<{ text: string; bold: boolean }>(),
    })
    expect(msg.set({ value: 42 })).toEqual({ kind: 'set', value: 42 })
    expect(msg.label({ text: 'hi', bold: true })).toEqual({
      kind: 'label',
      text: 'hi',
      bold: true,
    })
  })

  /**
   * The variant's `kind` must always win over a payload-supplied
   * `kind` field; otherwise a typed escape hatch could forge a
   * different variant via the constructor and bypass the union.
   */
  it('forces the variant kind to win over a stray payload.kind', () => {
    const msg = defineMsgs({
      set: payload<{ value: number }>(),
    })
    // Cast through `unknown` because the public type rejects the
    // stray field; the test exists to guarantee the runtime guard.
    const out = msg.set({ value: 1, kind: 'other' } as unknown as { value: number })
    expect(out).toEqual({ kind: 'set', value: 1 })
  })

  /**
   * The phantom `_union` field is type-only. At runtime it must be
   * `undefined` so the builder serialises cleanly (e.g. for replay
   * fixtures) and so consumers cannot inspect a fake "all variants"
   * value through it.
   */
  it('exposes a runtime-undefined _union phantom', () => {
    const msg = defineMsgs({ inc: null })
    expect(msg._union).toBeUndefined()
  })

  /**
   * End-to-end: combine `defineMsgs`, `MsgOf`, and `createUpdate` in
   * the shape the §8 surface promises. Dispatch a helper-built
   * message and confirm the graph advances exactly as if the variant
   * had been hand-rolled.
   */
  it('drives a createUpdate runner end-to-end', () => {
    const msg = defineMsgs({
      inc: null,
      dec: null,
      set: payload<{ value: number }>(),
    })
    type CounterMsg = MsgOf<typeof msg>

    const graph = createCausl()
    const counter = graph.input('counter', 0)

    const update: Update<CounterMsg> = createUpdate<CounterMsg>({
      inc: (_m, g) => {
        g.commit('inc', (tx) => tx.set(counter, g.read(counter) + 1))
      },
      dec: (_m, g) => {
        g.commit('dec', (tx) => tx.set(counter, g.read(counter) - 1))
      },
      set: (m, g) => {
        g.commit('set', (tx) => tx.set(counter, m.value))
      },
    })

    update(msg.inc(), graph)
    expect(graph.read(counter)).toBe(1)
    update(msg.set({ value: 42 }), graph)
    expect(graph.read(counter)).toBe(42)
    update(msg.dec(), graph)
    expect(graph.read(counter)).toBe(41)
  })

  /**
   * `assertNever` is unreachable when the type-check passes. The
   * runtime throw is belt-and-suspenders for the case where a
   * non-TS caller (or a typing escape hatch) feeds the function a
   * non-`never` value.
   */
  it('assertNever throws with a descriptive message when reached', () => {
    expect(() => assertNever({ kind: 'rogue' } as never)).toThrowError(
      /assertNever: unexpected Msg variant/,
    )
  })
})
