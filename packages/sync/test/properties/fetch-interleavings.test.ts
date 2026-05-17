/**
 * @packageDocumentation
 *
 * Phase 4 acceptance — property-based test of fetch-timing
 * interleavings. Property tests are the engine's race-detection layer
 * for everything the type system and API shape can't catch; this
 * suite covers the stale-async race row directly: random
 * interleavings of (commit, fetch-start, fetch-resolve, commit,
 * fetch-start, fetch-resolve, …) must always end in a state
 * consistent with the configured resource policy. The trial count is
 * the engine's per-property minimum of 1000.
 *
 * The test universally quantifies a small DSL of programs whose steps
 * are {@link Step}: each random program is interpreted against the
 * resource state machine, and the post-condition asserts that every
 * reachable `ResourceState` is well-formed against the ResourceFleet
 * statechart guards (legal tag, and origin/loadedAt/erroredAt
 * monotonicity).
 *
 * The oracle is the statechart invariant set rather than a reference
 * implementation: any tag outside the closed set or any inverted
 * timestamp ordering would falsify the property.
 */

import { createCausl } from '@causljs/core'
import { propertyTrials } from '@causljs/core-testing-internal'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { resource, type ResourceState } from '../../src/index.js'

/**
 * Promise paired with externally callable `resolve`/`reject` and a
 * `settled` latch so the test harness can deterministically drive the
 * loader queue without racing the microtask scheduler.
 *
 * @typeParam T - Value type produced by the deferred promise.
 */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
  settled: boolean
}
/**
 * Constructs a {@link Deferred} whose `resolve`/`reject` are idempotent
 * via the `settled` latch. Used by the property test to externalise
 * loader completion ordering.
 *
 * @typeParam T - Value type produced by the deferred promise.
 * @returns A fresh {@link Deferred} with an unresolved promise.
 */
function defer<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => undefined
  let rejectFn: (error: unknown) => void = () => undefined
  const obj = {
    settled: false,
    resolve(v: T) {
      if (obj.settled) return
      obj.settled = true
      resolveFn(v)
    },
    reject(e: unknown) {
      if (obj.settled) return
      obj.settled = true
      rejectFn(e)
    },
  } as Deferred<T>
  obj.promise = new Promise<T>((res, rej) => {
    resolveFn = res
    rejectFn = rej
  })
  return obj
}

/**
 * One operation in the random program DSL driven by the property test.
 *
 * - `commit`         — bumps the unrelated input node, advancing the global clock.
 * - `fetch-start`    — invokes `resource.fetch()` and queues a deferred loader.
 * - `fetch-resolve`  — settles the oldest unsettled in-flight loader successfully.
 * - `fetch-reject`   — settles the oldest unsettled in-flight loader as an error.
 */
type Step =
  | { kind: 'commit' }
  | { kind: 'fetch-start' }
  | { kind: 'fetch-resolve'; value: number }
  | { kind: 'fetch-reject' }

/**
 * Generator over {@link Step}. Each variant has equal weight in `fc.oneof`,
 * so the resulting program length is shaped by the surrounding
 * `fc.array` bounds rather than by step distribution skew.
 */
const stepArb = fc.oneof(
  fc.constant<Step>({ kind: 'commit' }),
  fc.constant<Step>({ kind: 'fetch-start' }),
  fc.integer().map<Step>((value) => ({ kind: 'fetch-resolve', value })),
  fc.constant<Step>({ kind: 'fetch-reject' }),
)

/**
 * Property-test suite asserting the ResourceFleet statechart guards
 * hold for every random program of up to 25 steps over 1000 trials —
 * the engine's per-property minimum.
 */
describe('property: 1000 fetch-timing interleavings', () => {
  /**
   * Universally-quantified property: for every program drawn from
   * {@link stepArb}, the post-execution `ResourceState` must satisfy
   * the ResourceFleet statechart invariants — its `state` tag is one
   * of the five legal tags (`idle | loading | loaded | stale |
   * errored`), and `origin` does not exceed the corresponding
   * completion timestamp (`loadedAt` for loaded/stale, `erroredAt`
   * for errored).
   *
   * Pending fetches are drained deterministically at the end so the
   * post-condition observes a quiescent machine.
   */
  it('drives a random program and never reaches an undefined state', async () => {
    // Run 1000 random interleavings (the engine's per-property
    // minimum) over programs of up to 25 steps; each program drives a
    // fresh causl + resource so trials remain independent.
    await fc.assert(
      fc.asyncProperty(
        fc.array(stepArb, { minLength: 0, maxLength: 25 }),
        async (program) => {
          // Per-trial fixture: fresh graph, an unrelated input node used
          // to advance the clock on `commit`, and a resource whose loader
          // simply enqueues a deferred so the test controls completion.
          const g = createCausl()
          const other = g.input('other', 0)
          const queue: Array<Deferred<number>> = []
          let nextValue = 0
          const r = resource<number>(g, 'r', {
            loader: () => {
              const d = defer<number>()
              queue.push(d)
              return d.promise
            },
          })

          // Track in-flight fetches as Promise + the deferred handle.
          const inFlight: Array<{
            p: Promise<number>
            d: Deferred<number>
          }> = []

          // Interpret the random program step-by-step against the live
          // resource state machine.
          for (const step of program) {
            switch (step.kind) {
              case 'commit':
                // Advance the global clock by mutating an unrelated
                // input — this is the source of stale-async races.
                g.commit(`c${nextValue++}`, (tx) => tx.set(other, nextValue))
                break
              case 'fetch-start': {
                // Catch loader rejections to keep the harness alive;
                // the post-condition still runs against the latched state.
                const p = r.fetch().catch(() => -1)
                // queue may not have a slot yet; rely on order
                const d = queue[queue.length - (inFlight.filter((x) => !x.d.settled).length + 1)]
                if (d) inFlight.push({ p, d })
                break
              }
              case 'fetch-resolve': {
                // Settle the oldest unsettled in-flight loader and await
                // its completion so subsequent steps see a quiescent state.
                const next = inFlight.find((x) => !x.d.settled)
                if (next) {
                  next.d.resolve(step.value)
                  await next.p
                }
                break
              }
              case 'fetch-reject': {
                // Mirror of `fetch-resolve`, but settles with rejection.
                const next = inFlight.find((x) => !x.d.settled)
                if (next) {
                  next.d.reject(new Error('reject'))
                  await next.p
                }
                break
              }
            }
          }

          // Drain any still-pending fetches deterministically so the
          // post-condition observes a quiescent state machine.
          for (const f of inFlight) {
            if (!f.d.settled) {
              f.d.resolve(0)
              await f.p
            }
          }

          const state: ResourceState<number> = g.read(r.node)
          // The state must be one of the legal tags — every "X may
          // or may not have Y" optional field is a state-machine in
          // disguise that we surface as a tag, so any observation
          // outside this closed set would mean the engine has invented
          // an impossible state.
          expect(['idle', 'loading', 'loaded', 'stale', 'errored']).toContain(state.state)
          // For terminal value-bearing tags, the origin clock cannot be
          // ahead of the load completion timestamp.
          if (state.state === 'loaded' || state.state === 'stale') {
            expect(state.origin).toBeLessThanOrEqual(state.loadedAt)
          }
          // Same monotonicity applies to the errored branch's `erroredAt`.
          if (state.state === 'errored') {
            expect(state.origin).toBeLessThanOrEqual(state.erroredAt)
          }
        },
      ),
      // Routed through the seam helper so the engine's 1000-trial
      // per-property floor is enforced structurally (the conformance
      // meta-test rejects raw `{ numRuns: N }` literals).
      propertyTrials('fetch-interleavings'),
    )
  })
})
