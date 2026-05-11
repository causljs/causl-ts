/**
 * @packageDocumentation
 *
 * Behavioural pinning for the engine-instance flag-protocol layer
 * (#706b): the {@link CauslFlags} interface, the
 * {@link loadFlagsFromEnv} parser, and the
 * `createCausl({ experimentalFlags })` plumbing that lets a single
 * engine instance flip a flag without mutating the process-wide
 * env.
 *
 * The contract being pinned:
 *
 * - {@link MODULE_FLAGS} is a frozen snapshot read once at module
 *   load. Tests do not mutate it.
 * - {@link loadFlagsFromEnv} is pure with respect to its argument
 *   (which is `process.env`); a synthesized env via temporarily
 *   mutating `process.env.CAUSL_FREEZE_OFF_IN_PROD` for the
 *   duration of one assertion is enough to verify the parse rule.
 * - `createCausl({ experimentalFlags: { freezeOffInProd: true } })`
 *   honours the per-instance override even when the process-wide
 *   env is unset. The visible signal is that an engine-internal
 *   defensive freeze on `commit.changedNodes` is skipped — the
 *   array is `Object.isFrozen` `false` rather than `true`.
 *
 * The override-honoured assertion is the load-bearing one; it
 * verifies that {@link mergeFlags} actually flows the override into
 * the engine's freeze-helper closure, which is the whole point of
 * the protocol.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createCausl } from '../src/index.js'
import { loadFlagsFromEnv, MODULE_FLAGS } from '../src/flags.js'

/**
 * Restore an env var to its pre-test value, deleting it if it was
 * absent. Lets each test set `CAUSL_FREEZE_OFF_IN_PROD` for one
 * assertion without leaking into siblings.
 */
function restoreEnv(key: string, prior: string | undefined): void {
  if (prior === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = prior
  }
}

describe('flags.ts — engine-level CAUSL_* protocol', () => {
  /**
   * The MODULE_FLAGS snapshot is frozen so accidental mutation by a
   * consumer triggers a TypeError in strict mode rather than
   * silently desynchronising the engine from its declared flag
   * state.
   */
  it('exposes MODULE_FLAGS as a frozen snapshot', () => {
    expect(Object.isFrozen(MODULE_FLAGS)).toBe(true)
    // Schema check: the listed flags have the expected primitive types.
    expect(typeof MODULE_FLAGS.freezeOffInProd).toBe('boolean')
    expect(typeof MODULE_FLAGS.assertDeterministicCompute).toBe('boolean')
  })

  describe('loadFlagsFromEnv()', () => {
    /**
     * The parser refuses truthy-coercion vectors: only the literal
     * string `'1'` flips the flag. `'true'`, `'yes'`, and an empty
     * string all leave the flag at its conservative default.
     */
    it.each([
      ['1', true],
      ['0', false],
      ['true', false],
      ['yes', false],
      ['', false],
    ] as const)(
      'CAUSL_FREEZE_OFF_IN_PROD=%j → freezeOffInProd === %j',
      (envValue, expected) => {
        const prior = process.env.CAUSL_FREEZE_OFF_IN_PROD
        process.env.CAUSL_FREEZE_OFF_IN_PROD = envValue
        try {
          const flags = loadFlagsFromEnv()
          expect(flags.freezeOffInProd).toBe(expected)
          // Returned snapshot is also frozen.
          expect(Object.isFrozen(flags)).toBe(true)
        } finally {
          restoreEnv('CAUSL_FREEZE_OFF_IN_PROD', prior)
        }
      },
    )

    /**
     * With the env var entirely absent, the flag falls back to its
     * conservative default — defensive freezes stay enabled.
     */
    it('absent env var → freezeOffInProd === false', () => {
      const prior = process.env.CAUSL_FREEZE_OFF_IN_PROD
      delete process.env.CAUSL_FREEZE_OFF_IN_PROD
      try {
        const flags = loadFlagsFromEnv()
        expect(flags.freezeOffInProd).toBe(false)
      } finally {
        restoreEnv('CAUSL_FREEZE_OFF_IN_PROD', prior)
      }
    })
  })

  describe('createCausl({ experimentalFlags })', () => {
    /**
     * Capture the env state at suite start so each assertion can
     * delete `CAUSL_FREEZE_OFF_IN_PROD` and prove that the flag is
     * driven by the override alone, not by the process env.
     */
    let priorEnv: string | undefined
    afterEach(() => {
      restoreEnv('CAUSL_FREEZE_OFF_IN_PROD', priorEnv)
    })

    /**
     * Default behaviour (no override, env unset): the engine
     * defensively freezes inner arrays nested inside frozen Commit
     * payloads — `commit.changedNodes` is `Object.isFrozen`-tight.
     * This is the baseline the override flips off.
     */
    it('without override, commit.changedNodes is frozen (default)', () => {
      priorEnv = process.env.CAUSL_FREEZE_OFF_IN_PROD
      delete process.env.CAUSL_FREEZE_OFF_IN_PROD

      const g = createCausl()
      const a = g.input('a', 0)
      const c = g.commit('w1', (tx) => tx.set(a, 1))
      expect(Object.isFrozen(c.changedNodes)).toBe(true)
    })

    /**
     * The load-bearing assertion: an engine constructed with
     * `experimentalFlags: { freezeOffInProd: true }` skips the
     * inner-array freeze even when the process env is unset.
     * Verifies that mergeFlags actually flows the override into the
     * engine's freezeIfDev closure.
     */
    it('honours per-instance freezeOffInProd override (env unset)', () => {
      priorEnv = process.env.CAUSL_FREEZE_OFF_IN_PROD
      delete process.env.CAUSL_FREEZE_OFF_IN_PROD

      const g = createCausl({ experimentalFlags: { freezeOffInProd: true } })
      const a = g.input('a', 0)
      const c = g.commit('w1', (tx) => tx.set(a, 1))
      // Outer Commit object stays frozen at the public-surface
      // boundary — that contract is not flag-driven.
      expect(Object.isFrozen(c)).toBe(true)
      // Inner array is the one the flag covers; it must be NOT
      // frozen with the override on.
      expect(Object.isFrozen(c.changedNodes)).toBe(false)
    })

    /**
     * Explicit `freezeOffInProd: false` keeps the freeze on even if
     * the env says otherwise — the per-instance override wins.
     */
    it('per-instance override wins over env (override = false, env = "1")', () => {
      priorEnv = process.env.CAUSL_FREEZE_OFF_IN_PROD
      process.env.CAUSL_FREEZE_OFF_IN_PROD = '1'

      const g = createCausl({ experimentalFlags: { freezeOffInProd: false } })
      const a = g.input('a', 0)
      const c = g.commit('w1', (tx) => tx.set(a, 1))
      expect(Object.isFrozen(c.changedNodes)).toBe(true)
    })

    /**
     * Two engines constructed with different overrides retain
     * independent flag states — the merge happens at construction,
     * captured by per-instance closures, so the second `createCausl`
     * cannot retroactively change the first engine's freeze
     * behaviour.
     */
    it('two engines with different overrides keep independent flag state', () => {
      priorEnv = process.env.CAUSL_FREEZE_OFF_IN_PROD
      delete process.env.CAUSL_FREEZE_OFF_IN_PROD

      const off = createCausl({ experimentalFlags: { freezeOffInProd: true } })
      const on = createCausl({ experimentalFlags: { freezeOffInProd: false } })
      const aOff = off.input('a', 0)
      const aOn = on.input('a', 0)
      const cOff = off.commit('w1', (tx) => tx.set(aOff, 1))
      const cOn = on.commit('w1', (tx) => tx.set(aOn, 1))
      expect(Object.isFrozen(cOff.changedNodes)).toBe(false)
      expect(Object.isFrozen(cOn.changedNodes)).toBe(true)
    })
  })
})
