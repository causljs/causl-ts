/**
 * @packageDocumentation
 *
 * The `failing_against_stub` corpus — 20 categories pinpointing the
 * gap between `tools/engine-rs-core/src/lib.rs:209-214`'s
 * `transition_phased_stub(state, _action) -> Commit { changed_nodes: [],
 * time: state.now.wrapping_add(1) }` and the real TS engine's
 * `graph.commit(intent, run)` semantics.
 *
 * Per epic #1133 PLAN.md §6 (TDD-cluster verdict: "test must fail
 * first"). The corpus is the red lane that gates the Rust engine port:
 * every category must FAIL on `CAUSL_BACKEND=stub` today, PASS on
 * `CAUSL_BACKEND=ts`, and transition red→green on `CAUSL_BACKEND=rust`
 * as Phase A's 13 micro-tickets land.
 *
 * The fixture shape is language-agnostic — the Rust-side mirror at
 * `tools/engine-rs-core/tests/stub_corpus_categories.rs` consumes the
 * same category ids and asserts the stub's failure modes (empty
 * `changed_nodes`, no `intent` field, no `(State, Vec<PhaseStep>,
 * Vec<Event>)` tuple shape) from the other side of the bridge.
 *
 * Future stub-fix PRs force BOTH the TS-side gate AND the Rust-side
 * mirror to flip together — neither can drift independently.
 */

/**
 * One category of stub-vs-engine divergence. The shape is intentionally
 * minimal — `action` carries the SPEC §16.4.1 action variant tag and
 * payload; `setupInputs` and `setupDeriveds` describe the graph the
 * runner must construct before dispatching the action; `oracle` lists
 * the engine-side post-conditions the stub provably cannot meet.
 *
 * Empty `setupInputs` + empty `setupDeriveds` means "dispatch against
 * a fresh `createCausl()` graph". A non-empty list means "register
 * these nodes in order, then dispatch".
 */
export interface StubCategory {
  /** Kebab-case category id, matched verbatim on the Rust side. */
  readonly id: string
  /** One-line description for the test name. */
  readonly description: string
  /**
   * The SPEC §16.4.1 action variant + payload the runner dispatches.
   * `kind` matches the Rust `Action` arm name (`Commit`, `Tick`,
   * `Subscribe`, `Unsubscribe`, `ResolvePending`, `DispatchMsg`,
   * `BeginFetch`, `Dispose`). `payload` is the variant's named fields.
   */
  readonly action: { readonly kind: string; readonly payload: unknown }
  /**
   * Inputs to register on the graph before dispatch, in order.
   * `id` is the string-NodeId the application uses; `initial` is the
   * Phase-0 value.
   */
  readonly setupInputs: ReadonlyArray<{ readonly id: string; readonly initial: unknown }>
  /**
   * Deriveds to register after inputs, in order. `depsExpr` is a tiny
   * DSL the runner interprets:
   *   - `"sum:a,b"`        → numeric sum of the listed input ids
   *   - `"identity:a"`      → pass-through of input `a`
   *   - `"chain:a"`         → `get(a) + 1` (used to build chains)
   *   - `"cycle:self"`      → reads its own id (forces CycleError)
   */
  readonly setupDeriveds: ReadonlyArray<{ readonly id: string; readonly depsExpr: string }>
  /**
   * Engine-side post-conditions. The stub satisfies NONE of these for
   * any category. The TS engine satisfies every populated field for
   * its category. Each field is optional — an omitted field is "not
   * asserted for this category".
   */
  readonly oracle: {
    /** `Commit.changedNodes.length > 0`. */
    readonly changedNodesNonEmpty?: boolean
    /** Expected `Commit.intent` string. */
    readonly intentRoundtrip?: string
    /**
     * Expected ordered list of changed node string ids (the runner
     * canonicalises engine `NodeId` → string id via the registration
     * order recorded in `setupInputs` ++ `setupDeriveds`).
     */
    readonly changedNodeIds?: ReadonlyArray<string>
    /**
     * Expected `commit.time - baseTime` (baseTime = `graph.now` before
     * dispatch). Always 1 for one-shot `Commit` / `Tick`.
     */
    readonly timeAdvanceFromBase?: number
    /**
     * Per-subscriber trace: the ordered list of values the subscriber
     * observes during the dispatch. The runner registers a single
     * collecting subscriber on the named node before dispatch.
     */
    readonly subscriberTrace?: ReadonlyArray<unknown>
    /** Resource-fleet expected state for `begin-fetch`/`resolve-pending`. */
    readonly resourceState?: 'Loading' | 'Loaded'
    /** Delta in the queued-pipeline length for `dispatch-msg`. */
    readonly pipelineLengthDelta?: number
    /** Node id that must appear in `State.disposed` after dispatch. */
    readonly disposedContains?: string
    /**
     * Engine error class the dispatch must produce (cycle rejection,
     * post-dispose access, A.1 precondition guards).
     *
     * `CommitInProgressError` / `StaleTxError` are A.1 (#1338) — the
     * TS-engine surface throws these from `commitInternal` /
     * `Tx.set`; the Rust port surfaces them as `RaceClass::CommitInProgress`
     * / `RaceClass::StaleTx` via the precondition gate in
     * `tools/engine-rs-core/src/transition/validate.rs`. The Rust-side
     * variant tag and the TS-side class name are recorded here as the
     * SAME string token so the cross-backend assertion has one
     * canonical spelling to compare against.
     */
    readonly errorClass?:
      | 'NodeDisposedError'
      | 'RaceClass::CycleDetected'
      | 'CommitInProgressError'
      | 'StaleTxError'
    /**
     * `State::hash` must be byte-identical when the dispatch is
     * replayed against the same seed.
     */
    readonly stateHashStableAcrossRuns?: boolean
    /**
     * The real `transition_phased` returns `(State, Vec<PhaseStep>,
     * Vec<Event>)` — the stub returns a `Commit` struct. The runner
     * asserts the engine produces the tuple shape (presence of a
     * walk array) and the stub does not.
     */
    readonly returnShapeIsTuple?: boolean
    /**
     * Expected canonical sequence of phase steps (Rust:
     * `PhaseStep` variant names) the walker emits for this category.
     */
    readonly phaseStepSequence?: ReadonlyArray<string>
  }
}

/**
 * 22 categories — Phase-0 corpus per PLAN.md §6, extended by A.1
 * (#1338) with two precondition-guard categories that flip RED → GREEN
 * once the validate gate in `tools/engine-rs-core/src/transition/validate.rs`
 * lands.
 *
 * Each id is kebab-case and used verbatim by the Rust-side mirror at
 * `tools/engine-rs-core/tests/stub_corpus_categories.rs` and the
 * dedicated Rust-side precondition test at
 * `tools/engine-rs-core/tests/precondition_guards.rs`.
 */
export const STUB_CORPUS: ReadonlyArray<StubCategory> = [
  // 1 — A.4, A.5 (slow-path staging + Phase B publish)
  {
    id: 'tx-set-single-input-changed-nodes-nonempty',
    description: 'tx.set on a single input publishes a non-empty changedNodes set',
    action: { kind: 'Commit', payload: { intent: 'single-set', writes: [{ id: 'a', value: 42 }] } },
    setupInputs: [{ id: 'a', initial: 0 }],
    setupDeriveds: [],
    oracle: {
      changedNodesNonEmpty: true,
      changedNodeIds: ['a'],
      timeAdvanceFromBase: 1,
    },
  },
  // 2 — A.5 (Phase B publish, insertion-stable order)
  {
    id: 'tx-set-two-inputs-changed-nodes-stable-order',
    description: 'tx.set on two inputs publishes both in insertion-stable order',
    action: {
      kind: 'Commit',
      payload: {
        intent: 'two-sets',
        writes: [
          { id: 'a', value: 1 },
          { id: 'b', value: 2 },
        ],
      },
    },
    setupInputs: [
      { id: 'a', initial: 0 },
      { id: 'b', initial: 0 },
    ],
    setupDeriveds: [],
    oracle: {
      changedNodesNonEmpty: true,
      changedNodeIds: ['a', 'b'],
      timeAdvanceFromBase: 1,
    },
  },
  // 3 — A.4, A.5 (intent roundtrip)
  {
    id: 'tx-set-intent-roundtrip',
    description: 'commit.intent round-trips the caller-supplied label',
    action: {
      kind: 'Commit',
      payload: { intent: 'roundtrip-me', writes: [{ id: 'a', value: 7 }] },
    },
    setupInputs: [{ id: 'a', initial: 0 }],
    setupDeriveds: [],
    oracle: {
      intentRoundtrip: 'roundtrip-me',
      changedNodesNonEmpty: true,
    },
  },
  // 4 — A.3 (GraphTime monotonicity)
  {
    id: 'tx-set-time-advances-by-one-per-commit',
    description: 'graph.now advances by exactly 1 per commit',
    action: {
      kind: 'Commit',
      payload: { intent: 'time-tick', writes: [{ id: 'a', value: 1 }] },
    },
    setupInputs: [{ id: 'a', initial: 0 }],
    setupDeriveds: [],
    oracle: {
      timeAdvanceFromBase: 1,
      // The stub never round-trips intent — it returns a Commit with
      // no `intent` field at all. The TS engine round-trips it
      // verbatim. Asserting both pins the time advance AND forces the
      // stub to fail through the intent channel.
      intentRoundtrip: 'time-tick',
    },
  },
  // 5 — A.5 (Object.is equality cutoff)
  {
    id: 'tx-set-equality-cutoff-changed-nodes-empty',
    description: 'tx.set on equal value (Object.is) yields empty changedNodes',
    action: {
      kind: 'Commit',
      payload: { intent: 'equal-write', writes: [{ id: 'a', value: 0 }] },
    },
    setupInputs: [{ id: 'a', initial: 0 }],
    setupDeriveds: [],
    oracle: {
      changedNodesNonEmpty: false,
      changedNodeIds: [],
      timeAdvanceFromBase: 1,
      // Equality cutoff still produces a real Commit record with
      // intent — the stub has no intent channel, so the oracle's
      // intent-roundtrip forces a stub failure here too.
      intentRoundtrip: 'equal-write',
    },
  },
  // 6 — Phase B (#1134) derived chain
  {
    id: 'derived-chain-depth-2-publishes-all',
    description: 'derived chain of depth 2 publishes every affected node',
    action: {
      kind: 'Commit',
      payload: { intent: 'chain-write', writes: [{ id: 'a', value: 1 }] },
    },
    setupInputs: [{ id: 'a', initial: 0 }],
    setupDeriveds: [
      { id: 'd1', depsExpr: 'chain:a' },
      { id: 'd2', depsExpr: 'chain:d1' },
    ],
    oracle: {
      changedNodesNonEmpty: true,
      changedNodeIds: ['a', 'd1', 'd2'],
    },
  },
  // 7 — Phase C (#1144) commit log monotonic append
  {
    id: 'commit-log-monotonic-append',
    description: 'commitLog appends one entry per commit, monotonic by time',
    action: {
      kind: 'Commit',
      payload: { intent: 'log-append', writes: [{ id: 'a', value: 5 }] },
    },
    setupInputs: [{ id: 'a', initial: 0 }],
    setupDeriveds: [],
    oracle: {
      // Subscriber on `commitLog` should see exactly one new entry with time = baseTime+1.
      subscriberTrace: [1],
      timeAdvanceFromBase: 1,
    },
  },
  // 8 — Phase C (#1144) retention buffer
  {
    id: 'retention-buf-most-recent-K',
    description: 'retention buffer holds the most recent K snapshots',
    action: {
      kind: 'Commit',
      payload: { intent: 'retain', writes: [{ id: 'a', value: 99 }] },
    },
    setupInputs: [{ id: 'a', initial: 0 }],
    setupDeriveds: [],
    oracle: {
      // After commit, readAt(a, now) returns the new value — the
      // retention buffer keeps it addressable. The stub never grows
      // retention.
      changedNodeIds: ['a'],
      timeAdvanceFromBase: 1,
    },
  },
  // 9 — Phase D (#1136) subscriber fires on change
  {
    id: 'subscribe-fires-on-changing-commit',
    description: 'subscribe(node) fires exactly once on a commit that changed node',
    action: {
      kind: 'Commit',
      payload: { intent: 'fire-sub', writes: [{ id: 'a', value: 11 }] },
    },
    setupInputs: [{ id: 'a', initial: 0 }],
    setupDeriveds: [],
    oracle: {
      // Subscriber on `a` collects: [0 (sync initial), 11 (post-commit)].
      subscriberTrace: [0, 11],
    },
  },
  // 10 — Phase D (#1136) IndexMap pin (insertion order)
  {
    id: 'subscribe-fire-order-insertion-stable',
    description: 'multi-subscriber fire order is registration-insertion-stable',
    action: {
      kind: 'Commit',
      payload: { intent: 'multi-fire', writes: [{ id: 'a', value: 3 }] },
    },
    setupInputs: [{ id: 'a', initial: 0 }],
    setupDeriveds: [],
    oracle: {
      // Two subscribers registered in order [s1, s2]; the runner
      // collects their fire-order as the trace. Expect s1 before s2.
      subscriberTrace: ['s1', 's2'],
    },
  },
  // 11 — A.2 (generational NodeId)
  {
    id: 'dispose-makes-node-stale',
    description: 'dispose then read surfaces NodeDisposedError',
    action: { kind: 'Dispose', payload: { node: 'a' } },
    setupInputs: [{ id: 'a', initial: 0 }],
    setupDeriveds: [],
    oracle: {
      disposedContains: 'a',
      errorClass: 'NodeDisposedError',
    },
  },
  // 12 — Phase E (#1135) subscriber bridge
  {
    id: 'unsubscribe-removes-from-all-buckets',
    description: 'unsubscribe removes the observer from every per-node bucket',
    action: { kind: 'Unsubscribe', payload: { observerId: 'o1' } },
    setupInputs: [{ id: 'a', initial: 0 }],
    setupDeriveds: [],
    oracle: {
      // After unsubscribe, a subsequent commit on `a` produces no
      // observer fire — the trace is empty (subscriber was disposed
      // before the post-action commit). The follow-up commit IS a
      // real commit on the engine, so the oracle also asserts the
      // intent round-trip ('post-unsub') and timeAdvance:1 from base
      // — both of which the stub cannot produce.
      subscriberTrace: [],
      intentRoundtrip: 'post-unsub',
      timeAdvanceFromBase: 1,
      changedNodeIds: ['a'],
    },
  },
  // 13 — post-Phase-A (resource fleet)
  {
    id: 'begin-fetch-resource-loading',
    description: 'BeginFetch moves the resource into the Loading state',
    action: { kind: 'BeginFetch', payload: { resource: 'r1' } },
    setupInputs: [],
    setupDeriveds: [],
    oracle: {
      resourceState: 'Loading',
    },
  },
  // 14 — post-Phase-A (resource fleet)
  {
    id: 'resolve-pending-resource-loaded',
    description: 'ResolvePending moves a Loading resource to Loaded',
    action: { kind: 'ResolvePending', payload: { resource: 'r1' } },
    setupInputs: [],
    setupDeriveds: [],
    oracle: {
      resourceState: 'Loaded',
    },
  },
  // 15 — post-Phase-A (msg pipeline)
  {
    id: 'dispatch-msg-queues-into-pipeline',
    description: 'DispatchMsg appends one entry to the pending pipeline',
    action: { kind: 'DispatchMsg', payload: { target: 'reducer', payload: { msg: 'noop' } } },
    setupInputs: [],
    setupDeriveds: [],
    oracle: {
      pipelineLengthDelta: 1,
    },
  },
  // 16 — A.3 (Tick advances only `now`)
  {
    id: 'tick-advances-now-only',
    description: 'Tick advances State.now by 1 and changes nothing else',
    action: { kind: 'Tick', payload: {} },
    setupInputs: [{ id: 'a', initial: 0 }],
    setupDeriveds: [],
    oracle: {
      timeAdvanceFromBase: 1,
      changedNodeIds: [],
      changedNodesNonEmpty: false,
      // The TS-side Tick analogue is `graph.commit('tick', () => {})`,
      // which round-trips the intent label. The stub has no intent
      // channel, so this oracle field forces a stub failure even
      // though the stub coincidentally produces empty changedNodes
      // and time+1 for any Tick-class action.
      intentRoundtrip: 'tick',
    },
  },
  // 17 — A.0 (ABI shape lock)
  {
    id: 'transition-phased-return-shape-is-tuple',
    description: 'real transition_phased returns (State, Vec<PhaseStep>, Vec<Event>); stub returns Commit struct',
    action: { kind: 'Tick', payload: {} },
    setupInputs: [],
    setupDeriveds: [],
    oracle: {
      returnShapeIsTuple: true,
    },
  },
  // 18 — Phase B (#1134) cycle rejection
  {
    id: 'cycle-rejection-surfaces-race-class',
    description: 'derivation cycle surfaces RaceClass::CycleDetected, not silent success',
    action: {
      kind: 'Commit',
      payload: { intent: 'close-cycle', writes: [{ id: 'a', value: 1 }] },
    },
    setupInputs: [{ id: 'a', initial: 0 }],
    setupDeriveds: [
      { id: 'd1', depsExpr: 'cycle:self' },
    ],
    oracle: {
      errorClass: 'RaceClass::CycleDetected',
    },
  },
  // 19 — A.10 (typestate refactor — byte-stable replay)
  {
    id: 'state-hash-byte-stable-across-runs',
    description: 'State::hash is byte-stable when the same action is replayed against the same seed',
    action: {
      kind: 'Commit',
      payload: { intent: 'hash-stable', writes: [{ id: 'a', value: 1 }] },
    },
    setupInputs: [{ id: 'a', initial: 0 }],
    setupDeriveds: [],
    oracle: {
      stateHashStableAcrossRuns: true,
    },
  },
  // 20 — Phase B/C/D (full phase walker)
  {
    id: 'phase-walk-emits-canonical-step-sequence',
    description: 'phase walker emits the canonical PhaseStep sequence for a single-write commit',
    action: {
      kind: 'Commit',
      payload: { intent: 'walk-shape', writes: [{ id: 'a', value: 1 }] },
    },
    setupInputs: [{ id: 'a', initial: 0 }],
    setupDeriveds: [],
    oracle: {
      // The TS engine doesn't expose PhaseStep names; this oracle is
      // shape-bearing rather than content-bearing on the TS side
      // (the Rust mirror asserts the variant names).
      phaseStepSequence: [
        'StageWrites',
        'PublishB',
        'RecomputeD',
        'StampLastWriteTimeC5',
        'DispatchSubscribersG',
      ],
    },
  },
  // 21 — A.1 (#1338) precondition: re-entrancy guard.
  //
  // The TS oracle dispatches a NESTED `graph.commit()` from inside an
  // outer commit's `run` callback; the engine throws
  // `CommitInProgressError` (graph.ts:4134). The Rust port surfaces the
  // same precondition firing as `RaceClass::CommitInProgress` via
  // `transition/validate.rs::check_precondition`. The stub provably
  // CANNOT model this firing — its `transition_phased_stub` ignores
  // state and returns `Commit { changedNodes: [], time: now+1 }` for
  // any action.
  //
  // The runner uses the `errorClass` oracle field to route this
  // category: when set to `'CommitInProgressError'`, `runOnTsEngine`
  // dispatches the nested-commit scenario and asserts the engine
  // throws the named error class.
  {
    id: 'precondition-nested-commit',
    description:
      'nested graph.commit() inside an outer run callback throws CommitInProgressError (graph.ts:4134)',
    action: {
      kind: 'Commit',
      payload: { intent: 'outer-commit', writes: [{ id: 'a', value: 1 }] },
    },
    setupInputs: [{ id: 'a', initial: 0 }],
    setupDeriveds: [],
    oracle: {
      errorClass: 'CommitInProgressError',
    },
  },
  // 22 — A.1 (#1338) precondition: stale-tx guard.
  //
  // The TS oracle captures the `tx` reference from inside `run`,
  // returns from `run`, then calls `tx.set(...)` on the captured
  // reference; the engine throws `StaleTxError` (graph.ts:4173). The
  // Rust port surfaces the same precondition firing as
  // `RaceClass::StaleTx`. The stub provably cannot model this firing.
  {
    id: 'precondition-stale-tx-after-run',
    description:
      'tx.set called on a captured Tx after run returned throws StaleTxError (graph.ts:4173)',
    action: {
      kind: 'Commit',
      payload: { intent: 'capture-tx', writes: [{ id: 'a', value: 1 }] },
    },
    setupInputs: [{ id: 'a', initial: 0 }],
    setupDeriveds: [],
    oracle: {
      errorClass: 'StaleTxError',
    },
  },
] as const

/**
 * Per-category projection of what `transition_phased_stub` produces.
 * Pure function — mirrors the stub semantics documented at
 * `tools/engine-rs-core/src/lib.rs:209-214` without any FFI call:
 * `changed_nodes: []`, `time: state.now + 1`, no `intent`, no `walk`,
 * no error channel, no observer trace, no resource state, no pipeline
 * mutation, no disposal, no hash stability claim, no return-shape
 * tuple.
 *
 * The runner compares this projection against the engine's actual
 * outcome — they MUST diverge on every category for the corpus to be
 * meaningful. If they ever match, the corpus is broken (false
 * negative).
 */
export interface StubProjection {
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
}

/**
 * Project the stub's behaviour for a category — what
 * `transition_phased_stub` WOULD return given `baseTime`.
 */
export function projectStubBehavior(
  _cat: StubCategory,
  baseTime: number,
): StubProjection {
  return {
    changedNodes: [],
    time: baseTime + 1,
    intent: null,
    subscriberTrace: [],
    disposedContains: null,
    errorClass: null,
    resourceState: null,
    pipelineLengthDelta: 0,
    returnShapeIsTuple: false,
    phaseStepSequence: [],
  }
}
