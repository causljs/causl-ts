/**
 * Property-based race-detection suite for useCauslFamily lifecycle.
 *
 * Closes #125. Property-based tests are the race-detection layer for
 * everything the type system and API shape don't catch — that is the
 * explicit testing contract this suite leans on. Concretely, no
 * random interleaving of mount/unmount may produce a state where the
 * family registry, the React refcount, and the engine disagree.
 *
 * Properties asserted:
 *   P1 — Registry/refcount agreement (deterministic interleavings).
 *   P2 — Statechart conformance: live (any consumers) ⊕ disposed
 *        (no consumers) partition; cross-key independence.
 *   P3 — Random renderHook-driven mount/unmount interleaving preserves
 *        the live/disposed partition for every key in the universe.
 *   P4 — Use-after-dispose impossibility (NodeDisposedError tag).
 *   P6 — Double-dispose idempotence (state-equivalent to single-dispose).
 *   P7 — Re-mount after full dispose yields a fresh factory invocation.
 *
 * P5 (`disposedLineage stays bounded under churn`) — the original P5
 * from the #178/#179 stack referred to a `disposedLineage` ring buffer
 * that was part of a superseded design; the engine landed in #209 does
 * not maintain a per-family lineage list, so the literal property has
 * no contract to assert against. The "no leak" intent is covered by
 * P3's universal partition check (every disposed key has refcount 0
 * and is absent from the per-provider registry after unmount).
 *
 * Disposal goes through `@causljs/core/internal`'s `dispose`, NOT a
 * `_dispose` method on the public Graph; the family registry is
 * per-provider (carried on `CauslContext`), NOT module-global.
 * Both follow from the internal-only API discipline: `_dispose` and
 * the `Disposed` node tag are adapter-level concerns (no application
 * code should call them directly), and the React hook owns the
 * concept of "this node's lifetime is bounded by a component's
 * mount." That makes mounting tests under one provider with N
 * consumers (rather than N separate providers) load-bearing — it's
 * the only configuration that actually exercises shared registry
 * state.
 */

import { createCausl, NodeDisposedError, type Graph, type Node } from '@causljs/core'
import { dispose } from '@causljs/core/internal'
import { propertyTrials } from '@causljs/core/testing'
import { act, render } from '@testing-library/react'
import fc from 'fast-check'
import { useEffect } from 'react'
import { describe, expect, it } from 'vitest'
import {
  CauslProvider,
  useCauslFamily,
  type FamilyFactory,
  type FamilyGraph,
} from '../src/index.js'

/** Drain the microtask queue used by deferred-dispose. */
async function flushMicrotasks(): Promise<void> {
  // Two awaits to drain queued microtasks that themselves queue more.
  await Promise.resolve()
  await Promise.resolve()
}

/**
 * One consumer of the family hook. Reports the resolved node back to
 * the test via the `onResolve` callback (run inside an effect so React
 * has actually mounted the component) and renders nothing.
 */
function Consumer<T>({
  k,
  factory,
  onResolve,
}: {
  k: string
  factory: FamilyFactory<T>
  onResolve: (k: string, node: Node<T>) => void
}) {
  const node = useCauslFamily(k, factory)
  useEffect(() => {
    onResolve(k, node)
  }, [k, node, onResolve])
  return null
}

/**
 * Build a tree of N consumers all under a SINGLE provider. The set of
 * keys passed in `slots` controls which consumers are mounted; flipping
 * a slot to `null` unmounts that consumer (refcount-decrement path).
 *
 * @internal
 */
function Tree<T>({
  graph,
  slots,
  factory,
  onResolve,
}: {
  graph: Graph
  slots: ReadonlyArray<string | null>
  factory: FamilyFactory<T>
  onResolve: (k: string, node: Node<T>) => void
}) {
  return (
    <CauslProvider graph={graph}>
      {slots.map((k, i) =>
        k === null ? null : (
          <Consumer key={`${i}:${k}`} k={k} factory={factory} onResolve={onResolve} />
        ),
      )}
    </CauslProvider>
  )
}

describe('useCauslFamily — property-based race detection (#125)', () => {
  /**
   * P1 — N parallel consumer mounts of the same key under one provider
   * share node identity; the factory runs exactly once.
   */
  it('P1 — N parallel mounts of the same key share identity', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 8 }),
        fc.string({ minLength: 1, maxLength: 6 }),
        async (mountCount, key) => {
          const g = createCausl()
          const resolved: Node<number>[] = []
          let factoryCalls = 0
          const factory = (graph: FamilyGraph, k: string) => {
            factoryCalls++
            return graph.input(`cell:${k}`, 0)
          }
          const onResolve = (_k: string, n: Node<number>) => resolved.push(n)
          const slots = Array.from({ length: mountCount }, () => key)
          const { unmount } = render(
            <Tree<number>
              graph={g}
              slots={slots}
              factory={factory}
              onResolve={onResolve}
            />,
          )
          // All N consumers see the same handle; factory ran once.
          const first = resolved[0]
          for (const n of resolved) expect(n).toBe(first)
          expect(factoryCalls).toBe(1)
          unmount()
          await act(async () => {
            await flushMicrotasks()
          })
        },
      ),
      propertyTrials('family-P1-identity'),
    )
  })

  /**
   * P2 — partial unmounts of duplicate-keyed consumers keep the node
   * live; full unmount disposes. Cross-key independence: disposing key
   * `A` must not affect key `B`.
   */
  it('P2 — partial unmounts keep node live; full unmount disposes; cross-key independence', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 6 }),
        fc.integer({ min: 0, max: 100 }),
        fc.tuple(
          fc.string({ minLength: 1, maxLength: 4 }),
          fc.string({ minLength: 1, maxLength: 4 }),
        ).filter(([a, b]) => a !== b),
        async (mountCount, dropSeed, [keyA, keyB]) => {
          const g = createCausl()
          const captured = new Map<string, Node<number>>()
          const factory = (graph: FamilyGraph, k: string) => graph.input(`cell:${k}`, 7)
          const onResolve = (k: string, n: Node<number>) => {
            if (!captured.has(k)) captured.set(k, n)
          }

          // Build a tree with `mountCount` copies of keyA plus one
          // independent witness on keyB. Tracking keyB lets P2 also
          // verify that disposing the keyA family leaves keyB untouched.
          const slotsA: (string | null)[] = Array.from(
            { length: mountCount },
            () => keyA,
          )
          const initialSlots = [...slotsA, keyB]
          const { rerender, unmount } = render(
            <Tree<number>
              graph={g}
              slots={initialSlots}
              factory={factory}
              onResolve={onResolve}
            />,
          )
          const nodeA = captured.get(keyA)!
          const nodeB = captured.get(keyB)!

          // Drop dropCount copies of keyA, keep at least one. keyB
          // remains mounted throughout this phase.
          const dropCount = dropSeed % mountCount
          const survivors = slotsA.map((k, i) => (i < dropCount ? null : k))
          rerender(
            <Tree<number>
              graph={g}
              slots={[...survivors, keyB]}
              factory={factory}
              onResolve={onResolve}
            />,
          )
          await act(async () => {
            await flushMicrotasks()
          })
          // keyA still live (still has consumers); keyB still live.
          expect(g.read(nodeA)).toBe(7)
          expect(g.read(nodeB)).toBe(7)

          // Drop all remaining keyA consumers; keep keyB.
          rerender(
            <Tree<number>
              graph={g}
              slots={[...slotsA.map(() => null), keyB]}
              factory={factory}
              onResolve={onResolve}
            />,
          )
          await act(async () => {
            await flushMicrotasks()
          })
          // keyA disposed; keyB independent and still alive.
          expect(() => g.read(nodeA)).toThrow(NodeDisposedError)
          expect(g.read(nodeB)).toBe(7)

          unmount()
          await act(async () => {
            await flushMicrotasks()
          })
          // keyB now disposed too.
          expect(() => g.read(nodeB)).toThrow(NodeDisposedError)
        },
      ),
      propertyTrials('family-P2-partition'),
    )
  })

  /**
   * P3 — random mount/unmount interleavings on a small key universe
   * must always satisfy: every key with at least one mounted consumer
   * is readable; every key whose consumers have all unmounted (after
   * the deferred-dispose microtask drains) is `NodeDisposedError`.
   */
  it('P3 — random mount/unmount interleavings preserve the live/disposed partition', async () => {
    type Op = { kind: 'mount'; slot: number; key: string } | { kind: 'unmount'; slot: number }
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.oneof(
            fc.record({
              kind: fc.constant('mount' as const),
              slot: fc.integer({ min: 0, max: 5 }),
              key: fc.constantFrom('K0', 'K1', 'K2'),
            }),
            fc.record({
              kind: fc.constant('unmount' as const),
              slot: fc.integer({ min: 0, max: 5 }),
            }),
          ),
          { minLength: 1, maxLength: 12 },
        ),
        async (ops) => {
          const g = createCausl()
          const captured = new Map<string, Node<number>>()
          const factory = (graph: FamilyGraph, k: string) => graph.input(`cell:${k}`, 1)
          const onResolve = (k: string, n: Node<number>) => {
            if (!captured.has(k)) captured.set(k, n)
          }

          // Slot model: each slot holds either null (empty) or a key.
          // `mount` fills only an empty slot; `unmount` empties only a
          // filled slot. This keeps the test driver well-formed
          // regardless of the random op stream.
          const slots: (string | null)[] = Array.from({ length: 6 }, () => null)
          const { rerender, unmount } = render(
            <Tree<number>
              graph={g}
              slots={slots}
              factory={factory}
              onResolve={onResolve}
            />,
          )

          for (const op of ops) {
            if (op.kind === 'mount' && slots[op.slot] === null) {
              slots[op.slot] = op.key
            } else if (op.kind === 'unmount' && slots[op.slot] !== null) {
              slots[op.slot] = null
            } else {
              continue
            }
            rerender(
              <Tree<number>
                graph={g}
                slots={[...slots]}
                factory={factory}
                onResolve={onResolve}
              />,
            )
            await act(async () => {
              await flushMicrotasks()
            })
          }

          // Universal partition check: live keys are readable; absent
          // keys throw NodeDisposedError.
          const liveKeys = new Set<string>()
          for (const k of slots) if (k !== null) liveKeys.add(k)
          for (const [k, n] of captured) {
            if (liveKeys.has(k)) {
              expect(g.read(n)).toBe(1)
            } else {
              expect(() => g.read(n)).toThrow(NodeDisposedError)
            }
          }

          unmount()
          await act(async () => {
            await flushMicrotasks()
          })
        },
      ),
      propertyTrials('family-P3-random-interleave'),
    )
  })

  /**
   * P4 — every disposed node reports as `NodeDisposedError` with
   * `kind === 'NodeDisposed'`. The structural assertion uses
   * `expect(...).toThrow(NodeDisposedError)` rather than try/catch so
   * vitest generates the failure message.
   */
  it('P4 — every disposed node throws NodeDisposedError with the right tag', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        async (rounds) => {
          const g = createCausl()
          const captured: { key: string; node: Node<number> }[] = []
          const factory = (graph: FamilyGraph, k: string) => graph.input(`cell:${k}`, 0)
          // For each round, mount one consumer for a unique key, then
          // unmount it; the deferred dispose drains before the next
          // round. We capture each node so the post-loop assertion
          // sweeps the whole disposed set.
          for (let r = 0; r < rounds; r++) {
            const key = `K${r}`
            let node: Node<number> | null = null
            const onResolve = (_k: string, n: Node<number>) => {
              node = n
            }
            const { unmount } = render(
              <Tree<number>
                graph={g}
                slots={[key]}
                factory={factory}
                onResolve={onResolve}
              />,
            )
            expect(node).not.toBeNull()
            captured.push({ key, node: node! })
            unmount()
            await act(async () => {
              await flushMicrotasks()
            })
          }
          for (const { node } of captured) {
            expect(() => g.read(node)).toThrow(NodeDisposedError)
            try {
              g.read(node)
            } catch (err) {
              // Structural guarantee: tagged error with the
              // documented `kind` field.
              expect(err).toBeInstanceOf(NodeDisposedError)
              expect((err as NodeDisposedError).kind).toBe('NodeDisposed')
            }
          }
        },
      ),
      propertyTrials('family-P4-disposed-tag'),
    )
  })

  /**
   * P6 — double-dispose is idempotent. Driving the family hook can't
   * directly cause a double dispose (the registry deletes its entry
   * before calling `dispose`), but the engine's idempotency guarantee
   * is what the hook relies on; if the engine ever started throwing on
   * a re-dispose, a StrictMode dance or a fast remount/unmount could
   * surface a regression. We assert the engine contract here.
   */
  it('P6 — double-dispose is idempotent (engine contract the hook depends on)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 6 }),
        async (key) => {
          const g = createCausl()
          const captured: Node<number>[] = []
          const onResolve = (_k: string, n: Node<number>) => captured.push(n)
          const { unmount } = render(
            <Tree<number>
              graph={g}
              slots={[key]}
              factory={(graph, k) => graph.input(`cell:${k}`, 5)}
              onResolve={onResolve}
            />,
          )
          const node = captured[0]!
          unmount()
          await act(async () => {
            await flushMicrotasks()
          })
          // First dispose already happened via the hook; second call
          // must be a no-op.
          expect(() => dispose(g, node)).not.toThrow()
          // Read still throws the same disposed error.
          expect(() => g.read(node)).toThrow(NodeDisposedError)
        },
      ),
      propertyTrials('family-P6-double-dispose'),
    )
  })

  /**
   * P7 — re-mount after full dispose yields a fresh factory call. Any
   * key that has been disposed and is then mounted again invokes the
   * factory anew; the freshly-resolved handle reflects the new entry,
   * not the tombstoned one.
   *
   * Note: the engine identifies nodes by their `id`, so a re-registered
   * id does not produce a "different identity" — the contract that
   * matters is that the FACTORY runs again (the family registry has
   * dropped its cache) and the engine reflects the fresh registration's
   * initial value, not a leftover one. Cf. P6 for the disposal-error
   * contract on the disposed handle while it is in fact disposed.
   */
  it('P7 — remount-after-dispose yields a fresh factory invocation', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 6 }),
        async (key) => {
          const g = createCausl()
          let factoryCalls = 0
          const captured: Node<number>[] = []
          const factory = (graph: FamilyGraph, k: string) => {
            factoryCalls++
            return graph.input(`cell:${k}`, factoryCalls)
          }
          const onResolve = (_k: string, n: Node<number>) => captured.push(n)

          // First mount round; capture the node and confirm its
          // initial value reflects factoryCalls === 1.
          const first = render(
            <Tree<number>
              graph={g}
              slots={[key]}
              factory={factory}
              onResolve={onResolve}
            />,
          )
          const oldNode = captured[0]!
          expect(g.read(oldNode)).toBe(1)
          first.unmount()
          await act(async () => {
            await flushMicrotasks()
          })
          // While the consumer is unmounted and the dispose microtask
          // has drained, the disposed handle reports as disposed.
          expect(() => g.read(oldNode)).toThrow(NodeDisposedError)

          // Second mount round: the family registry has dropped its
          // cache, so the factory runs again. The newly-resolved node
          // reflects the fresh registration's initial value (== 2).
          captured.length = 0
          const second = render(
            <Tree<number>
              graph={g}
              slots={[key]}
              factory={factory}
              onResolve={onResolve}
            />,
          )
          const newNode = captured[0]!
          expect(factoryCalls).toBe(2)
          expect(g.read(newNode)).toBe(2)
          second.unmount()
          await act(async () => {
            await flushMicrotasks()
          })
        },
      ),
      propertyTrials('family-P7-remount-after-dispose'),
    )
  })
})
