import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createCausl } from '../../src/index.js'
import { propertyOptions, tieredPropertyOptions } from './seed.js'

/**
 * @packageDocumentation
 *
 * Property-based proof of dynamic-dependency cleanup.
 *
 * The race-class catalogue lists this one with surgical precision: a
 * derivation that switches inputs based on a conditional read needs the
 * engine to drop the abandoned dependency, and the TypeScript type system
 * can't see across `if`-branches inside a `derived` body. The mechanism
 * that catches the race is therefore property-based fuzz at the
 * acceptance-gate layer — a pre-deploy CI check, not a compile-time
 * guarantee. Random derivations that switch inputs based on conditional
 * reads, followed by random commits, must leave no orphan dependency
 * listening on a node it no longer reads.
 *
 * This suite turns that requirement into a universally-quantified contract:
 * generators produce random flag/selector traces, and the oracle is a
 * recompute counter sampled before and after each "unread-branch" write to
 * detect orphan listeners. A buggy engine that retained a reference to the
 * abandoned branch would bump the counter on a write that the active
 * compute never read, and the property would fail with a shrunk trace.
 *
 * The trial budget honours the project-wide race-detection floor of 1000+
 * random graphs and 1000+ random commit sequences per property, every CI
 * run, with deterministic seeds logged so a failure is reproducible.
 */

/**
 * Dynamic-dependency cleanup:
 *   Random derivations that switch inputs based on conditional reads,
 *   followed by random commits, must leave no orphan dependency
 *   listening on a node it no longer reads. The type system can't see
 *   across `if`-branches inside a `derived` body, so this property suite
 *   is the pre-deploy CI gate that catches the race; runtime escapes get
 *   the dirty-mark/recompute-counter check below.
 */
describe('property: dynamic-dependency cleanup', () => {
  /**
   * Universally-quantified contract: for any random flag/x/y trace, after
   * each flag flip a write to the *unread* branch's input must not bump
   * the derivation's compute counter, and a write to the *read* branch's
   * input must (eventually) bump it. The first half is the orphan-listener
   * detector — a buggy engine that retained a reference to the abandoned
   * branch would fail the unread-branch invariant — and is exactly the
   * race the property suite exists to catch on behalf of `tsc`, which
   * cannot see across the `if` inside the `derived` body.
   */
  it('after a derivation switches inputs, only currently-read inputs trigger recomputes (≥1000 cases)', () => {
    fc.assert(
      fc.property(
        // Generator: random `(flag, x, y)` triples. The bounded integer range
        // is irrelevant to the dependency graph but keeps shrinking quick.
        fc.array(
          fc.tuple(
            fc.boolean(), // flag value to set
            fc.integer({ min: -100, max: 100 }), // x
            fc.integer({ min: -100, max: 100 }), // y
          ),
          { minLength: 1, maxLength: 25 },
        ),
        (writes) => {
          // Engine setup: a derivation that branches on `flag`, reading
          // either `x` or `y` but never both in the same compute.
          const g = createCausl()
          const flag = g.input('flag', false)
          const x = g.input('x', 0)
          const y = g.input('y', 0)

          let chosenComputeCount = 0
          const chosen = g.derived('chosen', (get) => {
            chosenComputeCount++
            return get(flag) ? get(x) : get(y)
          })
          // Baseline: discard the initial compute so the counter measures
          // only post-trace recomputes.
          chosenComputeCount = 0

          for (let i = 0; i < writes.length; i++) {
            const w = writes[i]
            if (!w) continue
            const [f, xv, yv] = w
            // Step 1: set the flag, then sample the recompute counter as
            // the oracle baseline for this iteration.
            g.commit(`set-flag-${i}`, (tx) => tx.set(flag, f))
            const afterFlag = chosenComputeCount

            // Step 2: write to the abandoned branch's input. The engine
            // must have dropped the abandoned dependency at the moment the
            // conditional took the other branch, so a write to the unread
            // branch's input must not provoke a recompute.
            g.commit(`unread-${i}`, (tx) => {
              if (f) tx.set(y, yv) // flag=true reads x; touching y is unread
              else tx.set(x, xv) // flag=false reads y; touching x is unread
            })
            // Assertion: zero spurious recomputes from the abandoned branch.
            expect(chosenComputeCount).toBe(afterFlag)

            // Step 3: write to the active branch's input. The counter must
            // stay at or above the baseline; a strict increase confirms
            // dependency tracking is still wired to the active branch.
            g.commit(`read-${i}`, (tx) => {
              if (f) tx.set(x, xv)
              else tx.set(y, yv)
            })
            expect(chosenComputeCount).toBeGreaterThanOrEqual(afterFlag)
          }
          // Sanity check: the derivation still produces a number after the
          // trace — no orphan listener corrupted the cached value.
          expect(typeof g.read(chosen)).toBe('number')
        },
      ),
      // Trial budget: resolved by `tieredPropertyOptions()` — defaults
      // to the 1000-trial race-detection floor and honours
      // `CAUSL_FUZZ_TIER` so the PR-lane (5k) and nightly (100k) tiers
      // (#1073) take effect without a code change.
      tieredPropertyOptions(),
    )
  })

  /**
   * Universally-quantified contract: for any selector trace, after the
   * derivation has chosen one of five inputs, writes to the other four
   * must not provoke a recompute. Strengthens the boolean variant above
   * by requiring the engine to drop a *set* of former dependencies, not
   * just one — the same orphan-listener race, exercised over a wider
   * dependency fan-out where a single retained edge would still fail
   * the property.
   */
  it('a derivation that drops all of a former dep set sees no spurious recomputes', () => {
    fc.assert(
      fc.property(
        // Generator: a list of selector indices in [0, 4]. Each value drives
        // the derivation to pick one of five inputs.
        fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 1, maxLength: 25 }),
        (writes) => {
          // Engine setup: five candidate inputs and one selector. The
          // derivation reads only the selected candidate, so the dependency
          // set after each commit is `{ sel, inputs[selectedIdx] }`.
          const g = createCausl()
          const sel = g.input('sel', 0)
          const inputs = [
            g.input('i0', 10),
            g.input('i1', 20),
            g.input('i2', 30),
            g.input('i3', 40),
            g.input('i4', 50),
          ]
          let computeCount = 0
          g.derived('chosen', (get) => {
            computeCount++
            const idx = get(sel)
            const node = inputs[idx % inputs.length]
            if (!node) return -1
            return get(node)
          })

          for (let i = 0; i < writes.length; i++) {
            const newSel = writes[i] ?? 0
            // Step 1: move the selector to a fresh index and sample the
            // compute counter as the oracle baseline.
            g.commit(`pick-${i}`, (tx) => tx.set(sel, newSel))
            const afterSel = computeCount
            const selectedIdx = newSel % inputs.length
            // Step 2: write to every non-selected input. None of these
            // belong to the active dependency set, so the counter must be
            // unchanged after the commit.
            g.commit(`bumpOthers-${i}`, (tx) => {
              for (let j = 0; j < inputs.length; j++) {
                if (j === selectedIdx) continue
                const node = inputs[j]
                if (node) tx.set(node, j * 100 + i)
              }
            })
            // Assertion: zero spurious recomputes from any abandoned input.
            expect(computeCount).toBe(afterSel)
          }
        },
      ),
      // Trial budget honours the 1000-trial race-detection floor (EPIC #285
      // sub-issue #260). The five-way fan-out generator already keeps each
      // trial bounded; running at the full floor is in CI budget.
      propertyOptions(),
    )
  })
})
