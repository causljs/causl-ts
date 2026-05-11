/**
 * Protocol-seam decode coverage (#379).
 *
 * `decodeDispatch` is the single point in the bridge where untrusted
 * wire messages are narrowed to the typed `DispatchEvent` form. Every
 * `as`-cast in the production path lives in this function — the
 * downstream handler table receives the narrowed payload and never
 * looks at the wire shape again.
 *
 * Coverage maps to the §17.4 / #379 acceptance:
 *   - JUMP_TO_STATE / JUMP_TO_ACTION: missing `state` collapses to
 *     `null`; the cast `(msg as { state?: unknown }).state` only
 *     survives here, not in the handler.
 *   - PAUSE_RECORDING / LOCK_CHANGES: the toggle-vs-set ambiguity is
 *     normalised into `_TOGGLE` / `_SET` variants.
 *   - IMPORT_STATE: the five-layer narrowing from the original
 *     handler is concentrated here; the post-decode payload is a
 *     non-empty `times` array.
 *   - Forward-compat: unknown DISPATCH kinds and non-DISPATCH
 *     envelopes return `null`.
 */

import { describe, expect, it } from 'vitest'
import { _internalForTests } from '../src/connect.js'

const { decodeDispatch } = _internalForTests

describe('decodeDispatch (#379)', () => {
  describe('JUMP_TO_STATE / JUMP_TO_ACTION', () => {
    it('lifts top-level `state: string` into the variant payload', () => {
      const event = decodeDispatch({
        type: 'DISPATCH',
        payload: { type: 'JUMP_TO_STATE' },
        state: 'snap-blob',
      } as never)
      expect(event).toEqual({ kind: 'JUMP_TO_STATE', state: 'snap-blob' })
    })

    it('returns null when `state` is missing', () => {
      // The whole point of #379 is that JUMP without `state` is a panel
      // bug, not a legitimate variant — the decode rejects it so the
      // handler never has to defend against it.
      const event = decodeDispatch({
        type: 'DISPATCH',
        payload: { type: 'JUMP_TO_STATE' },
      } as never)
      expect(event).toBeNull()
    })

    it('returns null when `state` is non-string', () => {
      const event = decodeDispatch({
        type: 'DISPATCH',
        payload: { type: 'JUMP_TO_ACTION' },
        state: 42 as unknown as string,
      } as never)
      expect(event).toBeNull()
    })
  })

  describe('PAUSE_RECORDING — toggle vs. set is encoded in the kind', () => {
    it('produces _TOGGLE when status is omitted', () => {
      const event = decodeDispatch({
        type: 'DISPATCH',
        payload: { type: 'PAUSE_RECORDING' },
      } as never)
      expect(event).toEqual({ kind: 'PAUSE_RECORDING_TOGGLE' })
    })

    it('produces _SET when status is a boolean', () => {
      expect(
        decodeDispatch({
          type: 'DISPATCH',
          payload: { type: 'PAUSE_RECORDING', status: true },
        } as never),
      ).toEqual({ kind: 'PAUSE_RECORDING_SET', status: true })
      expect(
        decodeDispatch({
          type: 'DISPATCH',
          payload: { type: 'PAUSE_RECORDING', status: false },
        } as never),
      ).toEqual({ kind: 'PAUSE_RECORDING_SET', status: false })
    })

    it('falls through to _TOGGLE when status is non-boolean junk', () => {
      // Defensive: the panel sometimes sends garbage. The wire-level
      // contract says boolean or absent; anything else collapses to
      // toggle rather than a hard reject so the operator's UI doesn't
      // freeze on malformed input.
      const event = decodeDispatch({
        type: 'DISPATCH',
        payload: { type: 'PAUSE_RECORDING', status: 'maybe' as unknown as boolean },
      } as never)
      expect(event).toEqual({ kind: 'PAUSE_RECORDING_TOGGLE' })
    })
  })

  describe('LOCK_CHANGES — toggle vs. set is encoded in the kind', () => {
    it('produces _TOGGLE when status is omitted', () => {
      expect(
        decodeDispatch({
          type: 'DISPATCH',
          payload: { type: 'LOCK_CHANGES' },
        } as never),
      ).toEqual({ kind: 'LOCK_CHANGES_TOGGLE' })
    })

    it('produces _SET when status is a boolean', () => {
      expect(
        decodeDispatch({
          type: 'DISPATCH',
          payload: { type: 'LOCK_CHANGES', status: true },
        } as never),
      ).toEqual({ kind: 'LOCK_CHANGES_SET', status: true })
    })
  })

  describe('IMPORT_STATE', () => {
    it('extracts a non-empty times array from computedStates', () => {
      const event = decodeDispatch({
        type: 'DISPATCH',
        payload: {
          type: 'IMPORT_STATE',
          nextLiftedState: {
            computedStates: [
              { state: { time: 1 } },
              { state: { time: 2 } },
              { state: { time: 3 } },
            ],
          },
        },
      } as never)
      expect(event).toEqual({ kind: 'IMPORT_STATE', times: [1, 2, 3] })
    })

    it('skips entries whose state lacks a numeric time', () => {
      const event = decodeDispatch({
        type: 'DISPATCH',
        payload: {
          type: 'IMPORT_STATE',
          nextLiftedState: {
            computedStates: [
              { state: { time: 1 } },
              { state: null },
              { state: { time: 'not-a-number' } },
              { state: { time: 5 } },
            ],
          },
        },
      } as never)
      expect(event).toEqual({ kind: 'IMPORT_STATE', times: [1, 5] })
    })

    it('returns null when computedStates is empty', () => {
      expect(
        decodeDispatch({
          type: 'DISPATCH',
          payload: {
            type: 'IMPORT_STATE',
            nextLiftedState: { computedStates: [] },
          },
        } as never),
      ).toBeNull()
    })

    it('returns null when nextLiftedState is missing', () => {
      expect(
        decodeDispatch({
          type: 'DISPATCH',
          payload: { type: 'IMPORT_STATE' },
        } as never),
      ).toBeNull()
    })

    it('returns null when no entry has a numeric time', () => {
      expect(
        decodeDispatch({
          type: 'DISPATCH',
          payload: {
            type: 'IMPORT_STATE',
            nextLiftedState: { computedStates: [{ state: null }] },
          },
        } as never),
      ).toBeNull()
    })
  })

  describe('parameterless variants', () => {
    it('decodes COMMIT / ROLLBACK / SWEEP / TOGGLE_PERSIST', () => {
      expect(
        decodeDispatch({ type: 'DISPATCH', payload: { type: 'COMMIT' } } as never),
      ).toEqual({ kind: 'COMMIT' })
      expect(
        decodeDispatch({ type: 'DISPATCH', payload: { type: 'ROLLBACK' } } as never),
      ).toEqual({ kind: 'ROLLBACK' })
      expect(
        decodeDispatch({ type: 'DISPATCH', payload: { type: 'SWEEP' } } as never),
      ).toEqual({ kind: 'SWEEP' })
      expect(
        decodeDispatch({
          type: 'DISPATCH',
          payload: { type: 'TOGGLE_PERSIST' },
        } as never),
      ).toEqual({ kind: 'TOGGLE_PERSIST' })
    })
  })

  describe('TOGGLE_ACTION', () => {
    it('lifts numeric id into the payload', () => {
      expect(
        decodeDispatch({
          type: 'DISPATCH',
          payload: { type: 'TOGGLE_ACTION', id: 7 },
        } as never),
      ).toEqual({ kind: 'TOGGLE_ACTION', id: 7 })
    })

    it('returns null when id is non-numeric', () => {
      expect(
        decodeDispatch({
          type: 'DISPATCH',
          payload: { type: 'TOGGLE_ACTION', id: 'nope' as unknown as number },
        } as never),
      ).toBeNull()
    })
  })

  describe('forward compatibility', () => {
    it('returns null for non-DISPATCH envelopes', () => {
      expect(decodeDispatch({ type: 'START' } as never)).toBeNull()
      expect(decodeDispatch({ type: 'STOP' } as never)).toBeNull()
      expect(decodeDispatch({ type: 'ACTION' } as never)).toBeNull()
    })

    it('returns null for unknown DISPATCH payload kinds', () => {
      expect(
        decodeDispatch({
          type: 'DISPATCH',
          payload: { type: 'NOT_A_REAL_MESSAGE' },
        } as never),
      ).toBeNull()
    })

    it('returns null when payload is missing', () => {
      expect(decodeDispatch({ type: 'DISPATCH' } as never)).toBeNull()
    })

    it('returns null when payload.type is missing', () => {
      expect(
        decodeDispatch({ type: 'DISPATCH', payload: {} } as never),
      ).toBeNull()
    })
  })
})
