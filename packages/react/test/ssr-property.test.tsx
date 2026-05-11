/**
 * SSR §15 property suite (#222) — closes the §15.2 fuzz gap left as
 * `it.todo` in `ssr.test.tsx`.
 *
 * Property
 * --------
 * For any (graph shape × server commit sequence × hydration point ×
 * client commit sequence), the observed value at every consumer
 * across the cross-product (server snapshot × client commit ×
 * hydrate) must resolve at one and the same GraphTime per render
 * frame, and post-hydrate the client's read of every node must equal
 * the server graph's read at the snapshot's time. This is the SPEC
 * §3 invariant — `derived(t) = f(b₁(t), …, bₙ(t))` — and the SPEC
 * §9.1 hydration-race contract — server snapshot applies atomically
 * and derived nodes recompute against the hydrated input set —
 * expressed as a property rather than a fixed example.
 *
 * Why a separate file
 * -------------------
 * `ssr.test.tsx` covers four hand-rolled examples: happy-path
 * equality, schema mismatch, concurrent edit during hydration,
 * empty-graph no-op. None of those falsifies the property "the
 * post-hydrate observation across an arbitrary DAG × commit
 * interleaving collapses to one GraphTime." This file plugs that gap
 * by leaning on the shared property generator (`propertyDag` +
 * `buildPropertyDag`) and the GraphTime trace assertion
 * (`assertConsistentGraphTime`) from `@causl/core/testing`.
 *
 * Trial floor
 * -----------
 * 1000 trials per property via `propertyTrials('ssr-hydrate-…')` —
 * the SPEC §15.2 contract enforced structurally by the testing seam.
 * `vitest.config.ts` already raises `testTimeout` to 120 s for
 * exactly this reason.
 */

import { createCausl, type Node } from '@causl/core'
import {
  assertConsistentGraphTime,
  buildPropertyDag,
  propertyDag,
  propertyTrials,
  type TraceEntry,
} from '@causl/core/testing'
import { act, cleanup, render } from '@testing-library/react'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { Hydrate, CauslProvider, useCausl } from '../src/index.js'

describe('SSR §15 fuzz property — hydrate preserves GraphTime invariant (#222)', () => {
  it(
    'property: snapshot/hydrate preserves GraphTime invariant across (server snapshot × client commit × hydrate)',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          // ---- Random DAG topology — by-construction acyclic, includes
          // diamond reconvergence so glitch-paths are reachable. Bounds
          // kept modest so the 1000-trial budget fits the suite timeout
          // comfortably (each trial does mount + N writes + cleanup,
          // dominated by jsdom).
          propertyDag({ minDerived: 2, maxDerived: 5 }),
          // ---- Server-side commit sequence: 0–4 random integer writes
          // to the input. The server graph progresses through these
          // before snapshotting.
          fc.array(fc.integer({ min: -100, max: 100 }), {
            minLength: 0,
            maxLength: 4,
          }),
          // ---- Hydration point: snapshot is taken after K of the
          // server commits, where 0 ≤ K ≤ serverCommits.length. Modelled
          // as a fraction so fast-check's shrinker collapses cleanly.
          fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true }),
          // ---- Post-hydrate client commit sequence: 0–3 writes
          // executed via `act(...)` after Hydrate has applied the
          // snapshot, so we exercise commits-after-restore.
          fc.array(fc.integer({ min: -100, max: 100 }), {
            minLength: 0,
            maxLength: 3,
          }),
          async (dag, serverCommits, hydratePointFrac, clientCommits) => {
            // ---- Server side ---------------------------------------
            const serverGraph = createCausl()
            const serverHandles = buildPropertyDag(serverGraph, dag)
            // Apply server-side commits up to the hydration point.
            const hydrateAt = Math.floor(
              hydratePointFrac * serverCommits.length,
            )
            for (let i = 0; i < hydrateAt; i++) {
              const value = serverCommits[i]!
              serverGraph.commit('s', (tx) =>
                tx.set(serverHandles.input, value),
              )
            }
            const snapshot = serverGraph.snapshot()
            // (Bonus belt-and-braces — server reads the same value at
            // snapshot time as the snapshot encodes; if not, the engine
            // is broken upstream of this property.)
            expect(serverGraph.now).toBe(snapshot.time)

            // ---- Client side ---------------------------------------
            // Build the same DAG topology so schemaHash matches; the
            // mismatch path is already covered by the existing
            // it('mismatch detection: …') in ssr.test.tsx.
            const clientGraph = createCausl()
            const clientHandles = buildPropertyDag(clientGraph, dag)
            // Pre-hydrate the client graph BEFORE rendering. #219 moved
            // <Hydrate>'s engine mutation out of the render body into
            // `useLayoutEffect` (render bodies must be pure under
            // concurrent rendering), so the first render reads the raw
            // client state. The host pre-hydrates the client engine
            // before the React tree mounts; <Hydrate> below stays as
            // the idempotent safety net (its WeakMap-keyed guard
            // short-circuits when the (graph, snapshot) pair is
            // already applied).
            clientGraph.hydrate(snapshot)

            // Capture every consumer's observation per render frame
            // for the assertConsistentGraphTime collapse.
            const trace: TraceEntry[] = []
            let frameId = 0

            // Two consumers per readable: one for the input, plus one
            // per derived. Reading every node forces a tearing chance
            // across the full DAG.
            const readables: Node<number>[] = [
              serverHandles.input as Node<number>,
              ...[...serverHandles.deriveds.values()].map(
                (n) => n as Node<number>,
              ),
            ]

            function Consumer({ idx }: { idx: number }) {
              const target = readables[idx]!
              const v = useCausl((g) => g.read(target))
              trace.push({
                frameId,
                selector: `c-${idx}->${target.id}`,
                value: v,
                time: clientGraph.now,
              })
              return null
            }

            try {
              render(
                <CauslProvider graph={clientGraph}>
                  <Hydrate snapshot={snapshot}>
                    {readables.map((_, i) => (
                      <Consumer key={i} idx={i} />
                    ))}
                  </Hydrate>
                </CauslProvider>,
              )

              // ---- Post-hydrate client commits -------------------
              for (const w of clientCommits) {
                frameId++
                act(() => {
                  clientGraph.commit('c', (tx) =>
                    tx.set(clientHandles.input, w),
                  )
                })
              }

              // ---- §3 invariant: every render frame collapses to
              // one GraphTime. A torn frame (two consumers seeing
              // different times for the same DAG) fires loud.
              assertConsistentGraphTime(trace)

              // ---- Post-hydrate parity: every node in the DAG
              // reads to the same value the server graph reads at
              // the snapshot's time, *modulo* any post-hydrate
              // client commits which advance the input on the
              // client side only. We re-derive the expected value
              // by walking the spec; for inputs the expectation is
              // either the snapshot input value (no client commits)
              // or the last client commit value (≥1 client commit);
              // for derived nodes the expectation is the same
              // sum-of-deps formula `buildPropertyDag` registered.
              const expectedInput =
                clientCommits.length > 0
                  ? clientCommits[clientCommits.length - 1]!
                  : (snapshot.inputs[dag.inputId] as number | undefined) ?? 0
              expect(clientGraph.read(clientHandles.input)).toBe(expectedInput)

              // Walk the DAG in topo order, computing the expected
              // sum-of-deps value to compare against the engine's
              // read. By-construction this is the same equation
              // buildPropertyDag uses, so we exercise the
              // determinism leg of §3 (every implementation that
              // claims `derived(t) = f(b₁(t), …)` must agree with
              // the spec or be wrong).
              const expectedById = new Map<string, number>()
              expectedById.set(dag.inputId, expectedInput)
              for (const ds of dag.deriveds) {
                let sum = 0
                for (const depId of ds.deps) {
                  sum += expectedById.get(depId)!
                }
                expectedById.set(ds.id, sum)
                const handle = clientHandles.deriveds.get(ds.id)!
                expect(clientGraph.read(handle)).toBe(sum)
              }
            } finally {
              cleanup()
            }
          },
        ),
        // §15.2 floor — 1000 trials per property; failing inputs
        // shrink to a regression case; seeds are deterministic and
        // logged so a CI failure is reproducible from the seed alone.
        propertyTrials('ssr-hydrate-graphtime'),
      )
    },
    // Long-running property: each trial mounts a React tree, runs
    // ≤4 commits, and unmounts; 1000 trials at ~10–30 ms each fits
    // well under the 120 s suite timeout.
    120_000,
  )
})
