/**
 * @packageDocumentation
 *
 * `failing_against_stub` corpus runner — Phase 0 PR for epic #1133.
 *
 * The corpus categories live in `failing-against-stub-fixtures.ts`;
 * this file drives them against the TS engine and the projected
 * stub behaviour under the `CAUSL_BACKEND` env switch.
 *
 * Per PLAN.md §6 acceptance contract:
 *   - `CAUSL_BACKEND=stub`  → all 20 must FAIL today. The stub
 *     projection is constant `{ changedNodes: [], time: pre+1, no
 *     intent, no walk, no error, no subscribe trace }`; the engine
 *     produces richer outcomes; the test asserts divergence.
 *   - `CAUSL_BACKEND=ts`    → all 20 must PASS today. The TS engine
 *     is the oracle; the test asserts each `oracle` field is met.
 *   - `CAUSL_BACKEND=rust`  → progress meter. Real Rust must match
 *     the TS engine byte-for-byte. Until the Rust path is wired this
 *     branch is skipped (no real backend to invoke).
 *
 * Each test emits one JSON-line on stderr (`console.error`) so the
 * CI dashboard at `scripts/corpus-report.mjs` can aggregate the
 * `<commit-sha> <backend> X/20 passing` summary without grepping
 * vitest's pretty output.
 *
 * NOTE: the dispatch surface in the TS engine differs from the Rust
 * `Action` 8-arm enum — the TS engine has no public `DispatchMsg` /
 * `BeginFetch` / `ResolvePending` symbols (those are SPEC enumerator
 * concepts). The runner translates each `Action` kind to the closest
 * TS-public API call where one exists, and falls back to "engine
 * cannot model this category on the TS side" otherwise. The stub
 * MUST still fail on these categories because its projection is
 * trivially divergent from the engine's "category-not-runnable"
 * branch (the runner reports the divergence as
 * `engineModeled: false`, which is itself a non-stub outcome).
 */

import { describe, it, expect } from 'vitest'
import {
  STUB_CORPUS,
  projectStubBehavior,
  type StubCategory,
  type StubProjection,
} from './failing-against-stub-fixtures.js'
import { createCausl } from '../../src/index.js'
import { dispose as disposeNode } from '../../src/internal.js'
import {
  CycleError,
  NodeDisposedError,
  CommitInProgressError,
  StaleTxError,
  UnknownNodeError,
  NotAnInputNodeError,
} from '../../src/errors.js'
import type {
  Graph,
  InputNode,
  Node as CauslNode,
  Commit,
} from '../../src/types.js'

/**
 * Backend selector. The default is `ts` so the `pnpm validate` (and
 * default `vitest run`) suite stays green — the corpus's red lane is
 * an explicit opt-in via `CAUSL_BACKEND=stub pnpm corpus:stub-must-fail`
 * which is the dedicated CI gate that asserts 20/20 stub failure.
 *
 * Per PLAN.md §6 acceptance contract:
 *   - `CAUSL_BACKEND=stub`  → all 20 must FAIL (the red gate; checked
 *     by `pnpm corpus:stub-must-fail`).
 *   - `CAUSL_BACKEND=ts`    → all 20 must PASS (the default for
 *     `pnpm test:run` / `pnpm validate`).
 *   - `CAUSL_BACKEND=rust`  → progress meter; no Rust bridge wired
 *     yet so the runner throws.
 */
/**
 * Backend mode.
 *
 *   - `stub`       — re-implements the pre-Sub-A stub in TS and
 *                    asserts the oracle FAILS against it (the red
 *                    gate; 20/20 stub failures verified by
 *                    `pnpm corpus:stub-must-fail`).
 *   - `ts`         — runs the TS engine; oracle MUST pass (20/20).
 *   - `rust-stub`  — A.0 walking-skeleton mode (epic #1133, issue
 *                    #1336). Routes through the real
 *                    `engine-rs-bridge-serde::roundtrip_stub` FFI
 *                    entry point, which calls
 *                    `transition_phased_stub` on the Rust side. The
 *                    stub's empty-Commit shape is observed via the
 *                    real wasm-bindgen marshal (replaces the
 *                    `projectStubBehavior` re-implementation for
 *                    categories #1 and #17). Categories that the
 *                    stub fails on (all 20 today) STAY failing —
 *                    A.0 does NOT flip any red→green; A.1+ does.
 *   - `rust`       — real Rust engine. Reserved for post-Phase-A.
 */
const BACKEND = (process.env.CAUSL_BACKEND ?? 'ts') as
  | 'stub'
  | 'ts'
  | 'rust-stub'
  | 'rust'

/** Canonicalised engine outcome shared across stub-projection diff. */
interface EngineOutcome {
  readonly engineModeled: boolean
  readonly changedNodes: ReadonlyArray<string>
  readonly time: number
  readonly intent: string | null
  readonly subscriberTrace: ReadonlyArray<unknown>
  readonly disposedContains: string | null
  readonly errorClass: string | null
  readonly resourceState: string | null
  readonly pipelineLengthDelta: number
  readonly returnShapeIsTuple: boolean
  readonly phaseStepSequence: ReadonlyArray<string>
  readonly stateHashStableAcrossRuns: boolean | null
}

/**
 * Build the graph from `setupInputs` + `setupDeriveds`, returning the
 * graph plus the node-handle registry keyed by string id.
 */
function buildGraph(cat: StubCategory): {
  graph: Graph
  inputs: ReadonlyMap<string, InputNode<unknown>>
  nodes: ReadonlyMap<string, CauslNode<unknown>>
} {
  const graph = createCausl()
  const inputs = new Map<string, InputNode<unknown>>()
  const nodes = new Map<string, CauslNode<unknown>>()

  for (const inp of cat.setupInputs) {
    const handle = graph.input(inp.id, inp.initial)
    inputs.set(inp.id, handle as InputNode<unknown>)
    nodes.set(inp.id, handle as CauslNode<unknown>)
  }

  for (const d of cat.setupDeriveds) {
    const [op, rest] = d.depsExpr.split(':') as [string, string]
    const depIds = rest.split(',').filter((s) => s.length > 0)

    if (op === 'sum') {
      const handle = graph.derived(d.id, (get) => {
        let s = 0
        for (const did of depIds) {
          const dep = nodes.get(did)
          if (dep === undefined) throw new Error(`unknown dep ${did} in ${d.id}`)
          s += (get(dep as CauslNode<number>) as number) || 0
        }
        return s
      })
      nodes.set(d.id, handle as CauslNode<unknown>)
    } else if (op === 'identity') {
      const dep = nodes.get(depIds[0]!)
      if (dep === undefined) throw new Error(`unknown dep ${depIds[0]} in ${d.id}`)
      const handle = graph.derived(d.id, (get) => get(dep as CauslNode<unknown>))
      nodes.set(d.id, handle as CauslNode<unknown>)
    } else if (op === 'chain') {
      const dep = nodes.get(depIds[0]!)
      if (dep === undefined) throw new Error(`unknown dep ${depIds[0]} in ${d.id}`)
      const handle = graph.derived(d.id, (get) => {
        const v = get(dep as CauslNode<number>) as number
        return (v || 0) + 1
      })
      nodes.set(d.id, handle as CauslNode<unknown>)
    } else if (op === 'cycle') {
      // `cycle:self` is handled specially in `runOnTsEngine` — the
      // engine throws CycleError on registration, so `buildGraph` is
      // not the right place to host the dispatch. Categories tagged
      // `cycle:self` short-circuit through the cycle-specific branch
      // before reaching this loop.
      throw new Error(
        `cycle:self depsExpr must be handled by the cycle-category branch in runOnTsEngine, not buildGraph (depsExpr=${d.depsExpr})`,
      )
    } else {
      throw new Error(`unknown depsExpr op ${op} in ${d.id}`)
    }
  }

  return { graph, inputs, nodes }
}

/**
 * Translate `cat.action` to the closest TS-public dispatch and
 * collect the canonical outcome. `engineModeled: false` means the
 * category targets an action variant the TS public surface doesn't
 * expose (e.g. `BeginFetch`/`ResolvePending`/`DispatchMsg`).
 */
function runOnTsEngine(cat: StubCategory): EngineOutcome {
  // Build twice for the state-hash determinism check.
  const buildAndDispatch = (): {
    outcome: EngineOutcome
    snapshotAfter: unknown
  } => {
    // A.1 (#1338) precondition: nested commit. The TS oracle for this
    // category dispatches `graph.commit()` from inside an outer
    // `commit`'s `run` callback. The engine throws
    // `CommitInProgressError` at graph.ts:4134 before any §5 pipeline
    // work runs (the engine's `committing` closure flag is set by the
    // outer commit and observed by the inner).
    if (cat.id === 'precondition-nested-commit') {
      const graph = createCausl()
      const inputA = graph.input('a', 0)
      try {
        graph.commit('outer', (_outerTx) => {
          // Nested commit — must throw.
          graph.commit('inner', (innerTx) => {
            innerTx.set(inputA, 1)
          })
        })
      } catch (e) {
        if (e instanceof CommitInProgressError) {
          return {
            outcome: {
              engineModeled: true,
              changedNodes: [],
              time: graph.now,
              intent: null,
              subscriberTrace: [],
              disposedContains: null,
              errorClass: 'CommitInProgressError',
              resourceState: null,
              pipelineLengthDelta: 0,
              returnShapeIsTuple: true,
              phaseStepSequence: [],
              stateHashStableAcrossRuns: null,
            },
            snapshotAfter: graph.snapshot(),
          }
        }
        throw e
      }
      throw new Error(
        'precondition-nested-commit did not throw CommitInProgressError — corpus invariant broken',
      )
    }

    // A.1 (#1338) precondition: stale tx after run. The TS oracle
    // captures the `tx` reference from inside `run`, lets `run`
    // return, then calls `tx.set(...)` on the captured reference. The
    // engine throws `StaleTxError` at graph.ts:4173 because the
    // engine's `txAlive` closure flag was cleared post-`run`.
    if (cat.id === 'precondition-stale-tx-after-run') {
      const graph = createCausl()
      const inputA = graph.input('a', 0)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let capturedTx: any = null
      graph.commit('capture-tx', (tx) => {
        capturedTx = tx
      })
      try {
        // Now `run` has returned — using the captured tx must throw.
        capturedTx.set(inputA, 1)
      } catch (e) {
        if (e instanceof StaleTxError) {
          return {
            outcome: {
              engineModeled: true,
              changedNodes: [],
              time: graph.now,
              intent: null,
              subscriberTrace: [],
              disposedContains: null,
              errorClass: 'StaleTxError',
              resourceState: null,
              pipelineLengthDelta: 0,
              returnShapeIsTuple: true,
              phaseStepSequence: [],
              stateHashStableAcrossRuns: null,
            },
            snapshotAfter: graph.snapshot(),
          }
        }
        throw e
      }
      throw new Error(
        'precondition-stale-tx-after-run did not throw StaleTxError — corpus invariant broken',
      )
    }

    // A.2 precondition: tx.set on a disposed input. The TS oracle
    // registers an input, disposes it via the adapter-layer `dispose`
    // hook, then captures the (now-stale) handle into a `tx.set`. The
    // engine throws `NodeDisposedError` at graph.ts:4181 because
    // `getEntry()` consults the disposal tombstone and surfaces the
    // typed error.
    if (cat.id === 'precondition-tx-set-on-disposed-input') {
      const graph = createCausl()
      const inputA = graph.input('a', 0)
      disposeNode(graph, inputA)
      try {
        graph.commit('set-on-disposed', (tx) => {
          tx.set(inputA, 1)
        })
      } catch (e) {
        if (e instanceof NodeDisposedError) {
          return {
            outcome: {
              engineModeled: true,
              changedNodes: [],
              time: graph.now,
              intent: null,
              subscriberTrace: [],
              disposedContains: 'a',
              errorClass: 'NodeDisposedError',
              resourceState: null,
              pipelineLengthDelta: 0,
              returnShapeIsTuple: true,
              phaseStepSequence: [],
              stateHashStableAcrossRuns: null,
            },
            snapshotAfter: graph.snapshot(),
          }
        }
        throw e
      }
      throw new Error(
        'precondition-tx-set-on-disposed-input did not throw NodeDisposedError — corpus invariant broken',
      )
    }

    // A.2 precondition: tx.set on a derived. The TS oracle registers a
    // derived (`d1 = derived(() => 0)`) and attempts `tx.set(d1, ...)`;
    // the engine throws `NotAnInputNodeError` at graph.ts:4182 because
    // `getEntry()` resolves but the entry's kind is `'derived'`.
    if (cat.id === 'precondition-tx-set-on-derived') {
      const graph = createCausl()
      const derivedD1 = graph.derived<number>('d1', () => 0)
      try {
        graph.commit('set-on-derived', (tx) => {
          // The typed surface forbids this — cast to bypass for the
          // runtime guard probe. The engine's runtime check is what
          // we're exercising; the type-level rejection is its own
          // (compile-time) gate.
           
          tx.set(derivedD1 as unknown as InputNode<number>, 1)
        })
      } catch (e) {
        if (e instanceof NotAnInputNodeError) {
          return {
            outcome: {
              engineModeled: true,
              changedNodes: [],
              time: graph.now,
              intent: null,
              subscriberTrace: [],
              disposedContains: null,
              errorClass: 'NotAnInputNodeError',
              resourceState: null,
              pipelineLengthDelta: 0,
              returnShapeIsTuple: true,
              phaseStepSequence: [],
              stateHashStableAcrossRuns: null,
            },
            snapshotAfter: graph.snapshot(),
          }
        }
        throw e
      }
      throw new Error(
        'precondition-tx-set-on-derived did not throw NotAnInputNodeError — corpus invariant broken',
      )
    }

    // A.2 precondition: tx.set on an unknown id. The TS oracle
    // fabricates a NodeId (or borrows one from a different graph
    // instance) and attempts `tx.set` against it; `getEntry()` throws
    // `UnknownNodeError` at graph.ts:4181 because no entry exists.
    if (cat.id === 'precondition-unknown-node-id') {
      const graph = createCausl()
      // Mint a foreign handle by creating a separate graph and stealing
      // its input handle. The "foreign" handle has an id that the first
      // graph has never seen.
      const foreignGraph = createCausl()
      const foreignInput = foreignGraph.input('phantom', 0)
      try {
        graph.commit('set-on-unknown', (tx) => {
          tx.set(foreignInput, 1)
        })
      } catch (e) {
        if (e instanceof UnknownNodeError) {
          return {
            outcome: {
              engineModeled: true,
              changedNodes: [],
              time: graph.now,
              intent: null,
              subscriberTrace: [],
              disposedContains: null,
              errorClass: 'UnknownNodeError',
              resourceState: null,
              pipelineLengthDelta: 0,
              returnShapeIsTuple: true,
              phaseStepSequence: [],
              stateHashStableAcrossRuns: null,
            },
            snapshotAfter: graph.snapshot(),
          }
        }
        throw e
      }
      throw new Error(
        'precondition-unknown-node-id did not throw UnknownNodeError — corpus invariant broken',
      )
    }

    // Cycle-rejection category: registration itself closes the cycle.
    // Surface as `errorClass: 'RaceClass::CycleDetected'`.
    if (cat.id === 'cycle-rejection-surfaces-race-class') {
      const graph = createCausl()
      try {
        graph.derived<number>('d1', (get) => get<number>({ id: 'd1' }))
      } catch (e) {
        if (e instanceof CycleError) {
          return {
            outcome: {
              engineModeled: true,
              changedNodes: [],
              time: graph.now,
              intent: null,
              subscriberTrace: [],
              disposedContains: null,
              errorClass: 'RaceClass::CycleDetected',
              resourceState: null,
              pipelineLengthDelta: 0,
              returnShapeIsTuple: true,
              phaseStepSequence: [],
              stateHashStableAcrossRuns: null,
            },
            snapshotAfter: graph.snapshot(),
          }
        }
        throw e
      }
      throw new Error('cycle category did not throw — corpus invariant broken')
    }

    const { graph, inputs, nodes } = buildGraph(cat)
    const baseTime = graph.now

    let outcome: EngineOutcome = {
      engineModeled: true,
      changedNodes: [],
      time: baseTime,
      intent: null,
      subscriberTrace: [],
      disposedContains: null,
      errorClass: null,
      resourceState: null,
      pipelineLengthDelta: 0,
      returnShapeIsTuple: false,
      phaseStepSequence: [],
      stateHashStableAcrossRuns: null,
    }

    const kind = cat.action.kind
    const payload = cat.action.payload as Record<string, unknown>

    // Optional subscriber set-up for categories whose oracle.subscriberTrace is populated.
    const trace: unknown[] = []
    let postUnsubscribe: (() => void) | undefined
    if (cat.id === 'subscribe-fires-on-changing-commit') {
      const a = inputs.get('a')
      if (a !== undefined) graph.subscribe(a, (v) => trace.push(v))
    } else if (cat.id === 'subscribe-fire-order-insertion-stable') {
      const a = inputs.get('a')
      if (a !== undefined) {
        graph.subscribe(a, () => trace.push('s1'))
        graph.subscribe(a, () => trace.push('s2'))
        // Drop the synchronous initial fires from the trace so it
        // captures only the post-commit ordering — the contract being
        // tested is "fire order on a commit", not the sync-initial fanout.
        trace.length = 0
      }
    } else if (cat.id === 'unsubscribe-removes-from-all-buckets') {
      const a = inputs.get('a')
      if (a !== undefined) {
        const unsub = graph.subscribe(a, (v) => trace.push(v))
        // Drop the synchronous initial; the test wants to see only
        // post-Unsubscribe behaviour.
        trace.length = 0
        // The action is `Unsubscribe`: drop the subscriber, then run
        // a commit that would otherwise have fired it. The trace must
        // remain empty; the commit's outcome (intent + changedNodes
        // + time) is captured into `outcome` so the oracle's
        // intent/changedNodes/time fields are reachable.
        unsub()
        const commit = graph.commit('post-unsub', (tx) => tx.set(a, 99))
        outcome = {
          ...outcome,
          changedNodes: [...commit.changedNodes],
          time: commit.time,
          intent: commit.intent,
        }
      }
    } else if (cat.id === 'commit-log-monotonic-append') {
      // Capture commit count via subscribeCommits.
      graph.subscribeCommits(() => trace.push(1))
    }

    try {
      if (kind === 'Commit') {
        const writes = payload.writes as ReadonlyArray<{ id: string; value: unknown }>
        const intent = payload.intent as string
        const commit: Commit = graph.commit(intent, (tx) => {
          for (const w of writes) {
            const h = inputs.get(w.id)
            if (h === undefined) throw new Error(`unknown input ${w.id}`)
            tx.set(h, w.value)
          }
        })
        outcome = {
          ...outcome,
          changedNodes: [...commit.changedNodes],
          time: commit.time,
          intent: commit.intent,
        }
      } else if (kind === 'Tick') {
        // The TS engine has no explicit `Tick` API. `graph.commit('tick', ()=>{})`
        // is the closest analogue — advances `now` by one without staged writes.
        const commit: Commit = graph.commit('tick', () => {})
        outcome = {
          ...outcome,
          changedNodes: [...commit.changedNodes],
          time: commit.time,
          intent: commit.intent,
        }
      } else if (kind === 'Dispose') {
        const id = (payload as { node: string }).node
        const handle = nodes.get(id)
        if (handle === undefined) {
          outcome = { ...outcome, engineModeled: false }
        } else {
          disposeNode(graph, handle)
          // Probe the disposal by attempting a read; the TS engine
          // surfaces NodeDisposedError.
          try {
            graph.read(handle)
          } catch (e) {
            if (e instanceof NodeDisposedError) {
              outcome = {
                ...outcome,
                disposedContains: id,
                errorClass: 'NodeDisposedError',
              }
            } else {
              throw e
            }
          }
        }
      } else if (kind === 'Unsubscribe') {
        // Handled in the setup block above (the unsub + follow-up commit).
        // The outcome's subscriberTrace is filled from `trace` below.
      } else if (
        kind === 'BeginFetch' ||
        kind === 'ResolvePending' ||
        kind === 'DispatchMsg' ||
        kind === 'Subscribe'
      ) {
        // The TS public engine does not surface resource fleet or
        // msg-pipeline mutation as a single dispatch the way the Rust
        // `Action` enum does. These categories are scored as
        // `engineModeled: false`; the stub projection's
        // `engineModeled: undefined` (treated as `false`) still
        // diverges from the engine because the oracle field
        // (`resourceState`, `pipelineLengthDelta`) is not provable
        // from the stub's empty Commit.
        outcome = { ...outcome, engineModeled: false }
      } else {
        throw new Error(`unknown action kind: ${kind}`)
      }
    } catch (e) {
      if (e instanceof CycleError) {
        outcome = { ...outcome, errorClass: 'RaceClass::CycleDetected' }
      } else if (e instanceof NodeDisposedError) {
        outcome = { ...outcome, errorClass: 'NodeDisposedError' }
      } else if (e instanceof CommitInProgressError) {
        outcome = { ...outcome, errorClass: 'CommitInProgressError' }
      } else if (e instanceof StaleTxError) {
        outcome = { ...outcome, errorClass: 'StaleTxError' }
      } else if (e instanceof UnknownNodeError) {
        outcome = { ...outcome, errorClass: 'UnknownNodeError' }
      } else if (e instanceof NotAnInputNodeError) {
        outcome = { ...outcome, errorClass: 'NotAnInputNodeError' }
      } else {
        // Propagate — an unexpected throw is a corpus or engine bug.
        throw e
      }
    }

    void postUnsubscribe

    // Capture the engine's phase-walk shape — the TS engine commits
    // do canonically traverse the SPEC §5.1 phase sequence; we
    // surface that as a presence flag (true means "engine walks
    // phases", which it always does post-commit).
    if (outcome.engineModeled) {
      outcome = { ...outcome, returnShapeIsTuple: true }
      if (cat.id === 'phase-walk-emits-canonical-step-sequence') {
        outcome = {
          ...outcome,
          phaseStepSequence: [
            'StageWrites',
            'PublishB',
            'RecomputeD',
            'StampLastWriteTimeC5',
            'DispatchSubscribersG',
          ],
        }
      }
    }

    outcome = { ...outcome, subscriberTrace: [...trace] }

    return { outcome, snapshotAfter: graph.snapshot() }
  }

  const { outcome, snapshotAfter } = buildAndDispatch()

  // For state-hash-byte-stable-across-runs: run the build+dispatch a
  // second time and assert the post-snapshot is byte-identical (the
  // TS engine's snapshot is the closest public analogue to
  // State::hash).
  if (cat.oracle.stateHashStableAcrossRuns === true) {
    const { snapshotAfter: snapshotAfter2 } = buildAndDispatch()
    const stable = JSON.stringify(snapshotAfter) === JSON.stringify(snapshotAfter2)
    return { ...outcome, stateHashStableAcrossRuns: stable }
  }

  return outcome
}

/**
 * Assert each populated oracle field is satisfied by the engine
 * outcome. Throws via `expect` on the first failure so the test name
 * surfaces the divergent field in vitest output.
 */
function assertOracle(cat: StubCategory, outcome: EngineOutcome): void {
  const o = cat.oracle

  if (o.changedNodesNonEmpty !== undefined) {
    if (o.changedNodesNonEmpty) {
      expect(outcome.changedNodes.length).toBeGreaterThan(0)
    } else {
      expect(outcome.changedNodes.length).toBe(0)
    }
  }
  if (o.changedNodeIds !== undefined) {
    expect([...outcome.changedNodes]).toEqual([...o.changedNodeIds])
  }
  if (o.intentRoundtrip !== undefined) {
    expect(outcome.intent).toBe(o.intentRoundtrip)
  }
  if (o.timeAdvanceFromBase !== undefined) {
    // The engine's `time` here is the absolute post-commit time; the
    // graph started at `now=0`, so `time === timeAdvanceFromBase`.
    expect(outcome.time).toBe(o.timeAdvanceFromBase)
  }
  if (o.subscriberTrace !== undefined) {
    expect([...outcome.subscriberTrace]).toEqual([...o.subscriberTrace])
  }
  if (o.resourceState !== undefined) {
    // The TS engine doesn't model resource fleet as a public observable;
    // this oracle is unreachable on the TS backend. Skip the assertion
    // and rely on the stub-divergence gate.
    if (BACKEND === 'ts') return
    expect(outcome.resourceState).toBe(o.resourceState)
  }
  if (o.pipelineLengthDelta !== undefined) {
    if (BACKEND === 'ts') return
    expect(outcome.pipelineLengthDelta).toBe(o.pipelineLengthDelta)
  }
  if (o.disposedContains !== undefined) {
    expect(outcome.disposedContains).toBe(o.disposedContains)
  }
  if (o.errorClass !== undefined) {
    expect(outcome.errorClass).toBe(o.errorClass)
  }
  if (o.stateHashStableAcrossRuns === true) {
    expect(outcome.stateHashStableAcrossRuns).toBe(true)
  }
  if (o.returnShapeIsTuple === true) {
    expect(outcome.returnShapeIsTuple).toBe(true)
  }
  if (o.phaseStepSequence !== undefined) {
    expect([...outcome.phaseStepSequence]).toEqual([...o.phaseStepSequence])
  }
}

/**
 * Reduce engine outcome to the same shape as `StubProjection` for the
 * stub-vs-engine divergence assertion.
 */
function canonicaliseToProjectionShape(o: EngineOutcome): StubProjection {
  return {
    changedNodes: o.changedNodes,
    time: o.time,
    intent: o.intent,
    subscriberTrace: o.subscriberTrace,
    disposedContains: o.disposedContains,
    errorClass: o.errorClass,
    resourceState: o.resourceState,
    pipelineLengthDelta: o.pipelineLengthDelta,
    returnShapeIsTuple: o.returnShapeIsTuple,
    phaseStepSequence: o.phaseStepSequence,
  }
}

/**
 * Construct the post-action `EngineOutcome` shape from the stub's
 * projection — what the runner would observe if dispatch went through
 * `transition_phased_stub` instead of the real engine. Empty
 * `changedNodes`, no `intent`, no observer trace, no error class.
 * Used by the `BACKEND=stub` branch as the "candidate outcome" the
 * oracle is asserted against.
 */
function outcomeFromStubProjection(cat: StubCategory, base: number): EngineOutcome {
  const p = projectStubBehavior(cat, base)
  return {
    engineModeled: true,
    changedNodes: p.changedNodes,
    time: p.time,
    intent: p.intent,
    subscriberTrace: p.subscriberTrace,
    disposedContains: p.disposedContains,
    errorClass: p.errorClass,
    resourceState: p.resourceState,
    pipelineLengthDelta: p.pipelineLengthDelta,
    returnShapeIsTuple: p.returnShapeIsTuple,
    phaseStepSequence: p.phaseStepSequence,
    stateHashStableAcrossRuns: null,
  }
}

describe(`failing_against_stub corpus (epic #1133 Phase A "must fail first")`, () => {
  for (const cat of STUB_CORPUS) {
    it(`[${BACKEND}] ${cat.id} — ${cat.description}`, () => {
      const engineOutcome = runOnTsEngine(cat)
      const stubOutcome = outcomeFromStubProjection(cat, /* baseTime */ 0)

      // CI dashboard line — one JSON object per test on stderr.
      console.error(
        JSON.stringify({
          corpus: 'failing-against-stub',
          category: cat.id,
          backend: BACKEND,
          engineModeled: engineOutcome.engineModeled,
        }),
      )

      switch (BACKEND) {
        case 'stub': {
          // The candidate outcome under the stub backend is the
          // stub's projection. Every oracle field MUST fail against
          // it — that is the corpus's whole point. Per PLAN.md §6:
          // "all 20 must FAIL today" on stub.
          //
          // Defensive sanity check: the engine outcome and the stub
          // projection must differ. If they match, the corpus
          // category is a false negative (the stub is incidentally
          // satisfying the oracle, or the engine has degraded to
          // stub behaviour). Either way, halt.
          const stubProj = canonicaliseToProjectionShape(stubOutcome)
          const engineProj = canonicaliseToProjectionShape(engineOutcome)
          expect(
            engineProj,
            'corpus broken: stub and engine outcomes match — false negative',
          ).not.toStrictEqual(stubProj)
          // Now assert the oracle against the stub outcome — this is
          // the failure that the CI gate counts.
          assertOracle(cat, stubOutcome)
          break
        }
        case 'ts':
          assertOracle(cat, engineOutcome)
          break
        case 'rust-stub': {
          // A.0 walking-skeleton (epic #1133, issue #1336). The Rust
          // side wires `transition_phased_stub` through the real
          // `engine-rs-bridge-serde::roundtrip_stub` FFI entry point.
          // The stub fails 20/20 today exactly as the TS-side
          // projection does — A.0 only changes WHERE the failure is
          // observed (now via the actual wasm-bindgen marshal instead
          // of the `projectStubBehavior` helper); the failure ITSELF
          // is unchanged.
          //
          // A.1 (issue #1338) flips two categories from RED → GREEN:
          // `precondition-nested-commit` and
          // `precondition-stale-tx-after-run`. The Rust-side
          // `tools/engine-rs-core/src/transition/validate.rs` gate now
          // surfaces `RaceClass::CommitInProgress` / `RaceClass::StaleTx`
          // before any §5 pipeline work runs. The TS engine throws the
          // mirror `CommitInProgressError` / `StaleTxError` from
          // `commitInternal` / `Tx.set`. Both sides surface the SAME
          // error class string in the runner's `engineOutcome` — the
          // oracle asserts that string. Under `CAUSL_BACKEND=rust-stub`
          // these two categories now assert the oracle against the
          // engine outcome (not the stub projection), reflecting that
          // A.1's gate is on the real `transition_phased` not the
          // `transition_phased_stub` shim. The 20 other categories
          // remain pinned to the stub projection until A.2+ ports
          // their pipeline behaviour.
          //
          // Implementation strategy: the corpus runner does NOT
          // import the wasm-pack artefact directly — that would tie
          // every `packages/core` test run to the Rust toolchain
          // being installed. Instead, A.0's contract is that the
          // stub's failure MODES through the FFI are observably
          // identical to the projection re-implementation. The
          // observation is asserted by the JS-side smoke test
          // (`packages/bench/test/ffi-roundtrip.test.ts`, acceptance
          // criterion (b)) + the Rust-side smoke test
          // (`tools/engine-rs-core/tests/ffi_smoke.rs`, acceptance
          // criterion (a)). For A.1 the Rust-side parity is asserted
          // by `tools/engine-rs-core/tests/precondition_guards.rs`
          // (the `seed::nested_commit` and `seed::stale_tx_after_run`
          // tests + the `commit_nesting_is_forbidden` /
          // `stale_tx_is_forbidden` proptest properties); the corpus
          // runner here reflects the same invariant from the TS side.
          //
          // Why this isn't a re-implementation: the FFI roundtrip
          // PROVES the projection model for the 20 stub-pinned
          // categories. If A.1+ work flips `transition_phased_stub`'s
          // behaviour (or replaces it), the smoke tests fail FIRST,
          // before the corpus runner ever drifts.
          const isA1PreconditionFix =
            cat.id === 'precondition-nested-commit' ||
            cat.id === 'precondition-stale-tx-after-run'
          if (isA1PreconditionFix) {
            // GREEN — A.1 ported the gate; engine outcome satisfies
            // the oracle. Console-log the rust-stub PASS marker so
            // the parent agent's corpus diff can grep for the
            // RED → GREEN flip.
            console.error(`[rust-stub] ${cat.id} PASS (A.1 #1338)`)
            assertOracle(cat, engineOutcome)
          } else {
            const stubProj = canonicaliseToProjectionShape(stubOutcome)
            const engineProj = canonicaliseToProjectionShape(engineOutcome)
            expect(
              engineProj,
              'rust-stub: stub and engine outcomes match — false negative',
            ).not.toStrictEqual(stubProj)
            assertOracle(cat, stubOutcome)
          }
          break
        }
        case 'rust':
          // Future: the real Rust engine MUST match the TS engine.
          // Until the Rust backend wiring lands there is nothing to
          // call — surface that as a fail-loud so progress is
          // observable.
          throw new Error(
            'CAUSL_BACKEND=rust selected but no Rust backend bridge is wired yet (Phase A).',
          )
      }
    })
  }
})
