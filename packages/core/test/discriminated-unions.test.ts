/**
 * @packageDocumentation
 *
 * EPIC #295 sub-issue #273 — exhaustiveness gates for the engine's
 * load-bearing discriminated unions.
 *
 * The doctrine: every "X may or may not have Y" optional field is a
 * state-machine-in-disguise that should be surfaced as a tag, and
 * every such union ships with an exhaustiveness check the type
 * system can enforce. A representation like
 * "has a value AND an error AND no AST AND no dependencies" should
 * not even be expressible — the discriminant rules it out.
 *
 * The "test" here is structural: each `dispatch*` helper calls
 * `assertNever` in its `default` arm. Adding a new variant to one of
 * the typed unions breaks compilation at the call site, surfacing the
 * gap before runtime instead of letting it slip through as a silent
 * fallback.
 *
 * The runtime checks are a defensive double-bind: if a caller smuggles
 * an `as any`-cast value past the type system, the throw signals it.
 */

import { describe, expect, it } from 'vitest'
import { assertNever } from '../src/internal.js'
import type { RetentionResult } from '../src/index.js'

describe('SPEC §17.4 exhaustiveness gates (#273)', () => {
  /**
   * `RetentionResult<T>` — the time-travel read-window discriminator
   * surfaced by `graph.readAt` / `graph.snapshotAt`. The `Evicted`
   * arm is the engine's honesty about bounded retention: time-travel
   * reads are bounded by `snapshotRetentionCap`, and a read past the
   * window narrows to `Evicted` rather than silently returning a
   * fake value. A new tag added here would break the dispatcher
   * below at compile time.
   */
  it('RetentionResult dispatcher covers every status', () => {
    function describe(r: RetentionResult<number>): string {
      switch (r.status) {
        case 'retained':
          return `retained:${r.value}@${r.time}`
        case 'evicted':
          return `evicted:${r.oldestRetainedTime}`
        default:
          return assertNever(r, 'RetentionResult')
      }
    }
    expect(describe({ status: 'retained', value: 42, time: 1 })).toBe('retained:42@1')
    expect(describe({ status: 'evicted', oldestRetainedTime: 7 })).toBe('evicted:7')
  })

  /**
   * `assertNever` itself: passing it a value the type system forced
   * to `never` does nothing useful at compile time (the call is
   * unreachable); passing it a smuggled value at runtime throws.
   */
  it('assertNever throws when reached at runtime via an `as never` cast', () => {
    expect(() => assertNever('rogue' as never)).toThrow(/unhandled discriminator/)
  })

  /**
   * The runtime hint is included verbatim in the thrown message so a
   * triage trace shows which dispatch site fell through.
   */
  it('assertNever includes the caller-supplied hint in the error', () => {
    expect(() => assertNever('x' as never, 'cycle.ts walk')).toThrow(/cycle.ts walk/)
  })
})
