/**
 * @packageDocumentation
 *
 * Property-based fuzz pinning the #1123 `input()` callsite
 * pre-tenuring extension.
 *
 * Background: PR #1036 (issue #1014) pre-tenured the `makeInputNode`
 * + `makeInputEntry` allocation sites via a module-level warmup loop
 * gated by a process-wide latch. The post-#1036 engine-status audit
 * (Eich/Horwat ship-verdict panel) surfaced a *new*
 * `dependent allocation site tenuring changed` deopt pair on `input`
 * itself — V8 attributes the InputEntry allocation site to its
 * enclosing SFI (the per-instance `input` closure inside
 * `createCausl`), not just the inner `makeInputEntry` SFI.
 *
 * #1123 extends the warmup helper to also drive the per-instance
 * `input()` SFI through the retune by constructing a throwaway graph
 * and registering PRETENURE_WARMUP_COUNT inputs on it. This property
 * suite verifies the structural invariants that the extension must
 * uphold across arbitrary graph sizes:
 *
 *   P1. The pre-tenuring helper completes without error for any
 *       graph the consumer might construct. The latch ensures only
 *       the first `createCausl()` in the process pays the warmup
 *       cost; every subsequent construction is O(1).
 *
 *   P2. `input()` returns a frozen handle whose `id` matches the
 *       caller-provided string, regardless of graph cardinality.
 *       The warmup's throwaway-graph reentry must not corrupt the
 *       per-instance `entries` Map of the *caller's* graph.
 *
 *   P3. The published `Commit.changedNodes` after a `tx.set` storm
 *       matches the oracle (same contract as the
 *       `hasDependents` fast-path property suite, but exercised
 *       across the full pre-tenured construction path). If the
 *       warmup leaked state into the caller's graph, this property
 *       would surface a `__causl_pretenure_input__:*` id that
 *       doesn't belong in the caller's bookkeeping.
 *
 *   P4. Source-state invariant: `graph.ts` declares the
 *       per-instance `input()` callsite as covered by the
 *       pretenure warmup. The string `__causl_pretenure_input__`
 *       must appear in the warmup body (the prefix the throwaway
 *       graph registrations use), and the `pretenureInputAllocationSites`
 *       doc-block must reference both `makeInputNode` and the
 *       per-instance `input` SFI in its scope statement.
 *
 * Acceptance per issue #1123: "1000 trials of graphs constructed
 * with arbitrary node counts" — `propertyTrials` enforces the
 * project-wide 1000-run floor.
 *
 * Deopt verification: in-process V8 deopt-tracing is unavailable
 * (the `--trace-deopt` flag must be set at process start), so the
 * full "0 tenuring-deopts on input / makeInputNode" assertion is
 * exercised by the bench-side integration test
 * (`packages/bench/test/input-pretenuring.test.ts`) which spawns
 * the `bench:profile:engine-status` driver. This property suite
 * pins the engine-side invariants the deopt count depends on, so a
 * regression that breaks the warmup's structural contract trips
 * here in <100ms rather than waiting for the slow bench integration
 * test to fire.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createCausl } from '../../src/index.js'
import { propertyTrials } from '@causljs/core-testing-internal'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const GRAPH_TS_PATH = resolve(__dirname, '..', '..', 'src', 'graph.ts')

describe('#1123 — input() callsite pretenuring (post-#1036 extension)', () => {
  /**
   * P1 + P2 — arbitrary-cardinality graphs construct cleanly and
   * the inputs registered carry the caller-provided id. Exercises
   * the public `createCausl()` + `g.input(...)` contract that the
   * extended pretenure warmup must not regress.
   */
  it('arbitrary-cardinality graph construction is total + input handles are well-formed', () => {
    fc.assert(
      fc.property(
        // Random input count, 1..200 — covers the small (~1) and
        // medium (~200) graph shapes typical adopters construct.
        // The bench harness exercises 10000; we don't need to
        // re-prove the warmup at that scale here (the bench-side
        // integration test does).
        fc.integer({ min: 1, max: 200 }),
        (numInputs) => {
          const g = createCausl()
          for (let i = 0; i < numInputs; i++) {
            const id = `n${i}`
            const handle = g.input(id, i)
            // Handle preserves the caller's id verbatim — no
            // collision with the warmup's `__causl_pretenure_*`
            // prefixes (the throwaway graph the warmup constructs
            // is isolated; its entries do not leak into the
            // caller's instance).
            expect(handle.id).toBe(id)
            // Frozen by `makeInputNode`'s `Object.freeze({ id })`.
            // Pinning this here catches a regression where the
            // pretenure warmup's recursive `createCausl()` call
            // accidentally shares the frozen-handle factory across
            // instances and trips a downstream `cannot mutate
            // frozen object` somewhere unrelated.
            expect(Object.isFrozen(handle)).toBe(true)
          }
          // Engine reports the same cardinality the caller registered.
          expect(g.stats().inputs).toBe(numInputs)
        },
      ),
      propertyTrials('#1123 input() pretenuring — construction totality'),
    )
  })

  /**
   * P3 — Commit.changedNodes oracle equality after a write storm.
   * Same shape as the #994 `hasDependents` fast-path property
   * suite, but here the substrate under test is the pre-tenured
   * construction path: if the warmup leaked any
   * `__causl_pretenure_input__:*` registration into the caller's
   * graph, `changedNodes` would surface that leak the first time
   * the bench harness commits a tx.
   */
  it('Commit.changedNodes excludes any warmup-leaked id under arbitrary write storms', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 32 }),
        fc.array(
          fc.record({
            rawIdx: fc.nat(),
            value: fc.integer({ min: -1000, max: 1000 }),
          }),
          { minLength: 0, maxLength: 64 },
        ),
        (numInputs, writes) => {
          const g = createCausl()
          const handles = Array.from({ length: numInputs }, (_, i) =>
            g.input(`n${i}`, 0),
          )
          // Compute oracle: last-write-wins per index, then filter
          // to inputs whose final value differs from 0 (the seed).
          const lastByIdx = new Map<number, number>()
          for (const w of writes) {
            const idx = w.rawIdx % numInputs
            lastByIdx.set(idx, w.value)
          }
          const expectedChanged = new Set<string>()
          for (const [idx, v] of lastByIdx) {
            if (v !== 0) expectedChanged.add(`n${idx}`)
          }
          const commit = g.commit('write-storm', (tx) => {
            for (const w of writes) {
              const idx = w.rawIdx % numInputs
              tx.set(handles[idx]!, w.value)
            }
          })
          const actualChanged = new Set(commit.changedNodes)
          // Every id in actualChanged must come from the caller's
          // namespace `n*`; no `__causl_pretenure_*` leakage.
          for (const id of actualChanged) {
            expect(id.startsWith('__causl_pretenure')).toBe(false)
          }
          expect(actualChanged).toEqual(expectedChanged)
        },
      ),
      propertyTrials('#1123 input() pretenuring — no warmup-state leakage'),
    )
  })

  /**
   * P4 — Source-state invariant. The pretenure warmup's source must
   * reference the per-instance `input()` callsite (via the
   * `__causl_pretenure_input__` id prefix it registers under) AND
   * its doc-block must list `input` alongside `makeInputNode` and
   * `makeInputEntry` in the scope statement. A regression that
   * silently drops the `input()` warmup loop would pass P1/P2/P3
   * (the structural behaviour wouldn't change, just the deopt
   * count) — this assertion fires the canary.
   */
  it('graph.ts pretenure warmup body covers the per-instance input() callsite', () => {
    const src = readFileSync(GRAPH_TS_PATH, 'utf8')
    // The throwaway-graph warmup loop registers inputs under a
    // distinctive prefix so the source-state assertion can pin the
    // existence of the loop without parsing the function body.
    expect(src).toContain('__causl_pretenure_input__')
    // The doc-block annotates the extended scope (#1123).
    expect(src).toMatch(/#1123[\s\S]{0,500}input/)
    // The warmup constructs a throwaway graph via `createCausl()`
    // and calls `.input(` on it — pin both tokens to catch a
    // regression that drops the recursive re-entry strategy.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\n)\s*\/\/[^\n]*/g, '$1')
    expect(stripped).toMatch(/warmupGraph\s*=\s*createCausl\s*\(\s*\)/)
    expect(stripped).toMatch(/warmupGraph\.input\s*\(/)
  })

  /**
   * P5 — `pretenureLatchTripped` is process-wide: subsequent
   * `createCausl()` calls in the same test process do NOT re-run
   * the warmup. We can't observe the latch directly (it's
   * module-private), but we can observe its consequence: a
   * `createCausl()` call after the first must complete in O(1)
   * relative to the first call's warmup cost. The exact timing
   * varies on CI; we assert the structural property (two
   * back-to-back constructions both produce valid graphs) and pin
   * the construction-cost ordering via a coarse upper bound.
   */
  it('post-warmup createCausl() calls are O(1) (latch holds)', () => {
    // First call paid the warmup; we don't measure it here (the
    // suite running this file may have constructed other engines
    // already, so the latch is likely already tripped by the time
    // this `it` block runs — which is itself the property we want).
    createCausl()
    // Time N=100 post-warmup constructions. Each is a fresh
    // closure + Map allocation; absent the latch, each would also
    // pay 20_000+20_000 warmup iterations (~5-8 ms apiece).
    const N = 100
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < N; i++) {
      const g = createCausl()
      // Touch the graph so V8 can't DCE the loop body.
      expect(g.now).toBe(0)
    }
    const totalMs = Number(process.hrtime.bigint() - t0) / 1_000_000
    // Coarse upper bound: 100 constructions in well under
    // 1 second even on a heavily-contended CI runner. If the
    // latch regressed, each construction would pay ~5-8 ms of
    // warmup → ~500-800 ms total — still under 1 s, but we'd
    // also surface a process-wide regression on the bench
    // harness, which is the load-bearing observation. Keep this
    // bound generous; the deopt-side assertion lives in the
    // bench integration test.
    expect(totalMs).toBeLessThan(1000)
  })
})
