/**
 * @packageDocumentation
 *
 * Structured error classes thrown by `@causljs/core` at runtime.
 *
 * I keep an honest catalogue of which races are eliminated structurally
 * and which require later layers — concurrent engine mutations, reads
 * of not-yet-loaded resources, partially-parsed formulas, reads inside
 * another transaction's staging window, diamond glitches, stale-async,
 * dynamic-dependency cleanup, derivation cycles, hydration mismatches,
 * use-after-dispose. Every class in this module is the typed surface
 * for one of those rows: callers branch on a tagged identity rather
 * than parse a string, and a single `instanceof CauslError` check
 * captures any engine-emitted failure.
 */

import type { NodeId } from './types.js'

/**
 * Base class for every error emitted by the causl engine.
 *
 * @remarks
 * Acts as a tagged-identity root: callers may `instanceof CauslError`
 * to distinguish engine-originated failures from host-thrown errors
 * propagated through observers.
 */
export class CauslError extends Error {
  override name = 'CauslError'
}

/**
 * Raised when a node id is registered twice on the same graph.
 *
 * @remarks
 * Node identities are unique within a graph: re-registration is
 * rejected at the call site that introduces the duplication. The
 * race this defeats is structural — there is no API to misuse,
 * because the engine refuses to associate two registrations with
 * one identity.
 *
 * @param id - The colliding node identifier.
 */
export class DuplicateNodeError extends CauslError {
  override name = 'DuplicateNodeError'
  constructor(public readonly id: NodeId) {
    super(`Node already registered: ${id}`)
  }
}

/**
 * Raised when an operation references a node id that does not exist
 * on the graph (e.g. reading or subscribing to an unregistered id).
 *
 * @remarks
 * The engine refuses to fabricate values for unknown identities. This
 * is the symmetric guard to {@link DuplicateNodeError}: registration is
 * rejected for known ids, and access is rejected for unknown ids.
 *
 * @param id - The unrecognised node identifier.
 */
export class UnknownNodeError extends CauslError {
  override name = 'UnknownNodeError'
  constructor(public readonly id: NodeId) {
    super(`Unknown node: ${id}`)
  }
}

/**
 * Raised when `tx.set` targets a derived node.
 *
 * @remarks
 * The runtime universe is two primitives: `InputNode<T>` (a writable
 * Behavior) and `DerivedNode<T>` (a Behavior computed from other
 * Behaviors). A derived value's meaning is `derived(t) = f(b1(t), …,
 * bn(t))` — a pure function of its dependencies at the same commit
 * moment. Permitting `tx.set` on a derived would tear that equation,
 * so the engine rejects the call at the API boundary rather than
 * accept a write that contradicts the value's denotational definition.
 *
 * @param id - The derived node id that was the target of `tx.set`.
 */
export class NotAnInputNodeError extends CauslError {
  override name = 'NotAnInputNodeError'
  constructor(public readonly id: NodeId) {
    super(`Cannot tx.set a derived node: ${id}`)
  }
}

/**
 * Raised when `graph.commit` is invoked while a commit is already
 * running on the same graph.
 *
 * @remarks
 * `graph.commit` is the only mutation entry-point: time advances by
 * exactly one per commit, and outside a commit the graph is read-only.
 * That shape eliminates concurrent writers by absence-of-API — there
 * is no concurrent-write surface to misuse. A re-entrant commit on a
 * single-threaded caller is the closest approximation of that race,
 * so the engine rejects it explicitly rather than let two commits
 * staging into the same window try to advance time together.
 */
export class CommitInProgressError extends CauslError {
  override name = 'CommitInProgressError'
  constructor() {
    super('A commit is already in progress; commits do not nest.')
  }
}

/**
 * Raised when a derivation graph closes a cycle on commit.
 *
 * @remarks
 * Cycle detection is runtime, first-commit — not compile-time. Static
 * cycle detection is a stretch goal owned by the bounded model checker;
 * the engine itself catches the cycle at the first commit that closes
 * it and surfaces the offending dependency path so callers can locate
 * the loop. The ordered `path` names every node participating in the
 * cycle in the order the engine traversed them.
 *
 * @param path - The ordered node identifiers participating in the cycle.
 */
export class CycleError extends CauslError {
  override name = 'CycleError'
  constructor(public readonly path: readonly NodeId[]) {
    super(`Derivation cycle detected: ${path.join(' → ')}`)
  }
}

/**
 * Raised when a {@link Tx} captured from a `commit` callback is used
 * after that callback returned.
 *
 * @remarks
 * The {@link Tx} handle is bounded to its commit. Inside a commit,
 * reads see staged writes; outside, reads see the previous committed
 * snapshot — there is no API to read inside another transaction's
 * staging window. This error is the symmetric guard for writes:
 * letting a stale `Tx` escape its callback would permit writes outside
 * the staging window, breaking the rule that exactly one new
 * `GraphTime` is produced per commit.
 */
export class StaleTxError extends CauslError {
  override name = 'StaleTxError'
  constructor() {
    super('Tx used outside its commit callback.')
  }
}

/**
 * Raised when `read`, `subscribe`, or `tx.set` targets a node that has
 * been disposed via the adapter-layer disposal hook
 * (`@causljs/core/internal`'s `dispose`).
 *
 * @remarks
 * Use-after-dispose on a family-keyed node is caught at compile time
 * by the `Disposed` discriminated tag and at runtime by this guard.
 * Disposal records a tombstone keyed by node id with the GraphTime at
 * which it was recorded; subsequent access through the public surface
 * surfaces this typed error rather than the generic
 * {@link UnknownNodeError}, so adapter authors can distinguish
 * "never registered" from "registered then released" — the type
 * narrows on the tag, and the runtime guard catches escapes.
 *
 * @param id - The disposed node identifier.
 * @param disposedAt - The GraphTime at which disposal was recorded.
 */
export class NodeDisposedError extends CauslError {
  override name = 'NodeDisposedError'
  /** Discriminated tag for exhaustive matching. */
  readonly kind = 'NodeDisposed' as const
  constructor(
    public readonly id: NodeId,
    public readonly disposedAt: number,
  ) {
    super(`Node "${id}" was disposed at t=${disposedAt}`)
  }
}

/**
 * Raised when adapter code attempts to dispose a node that still has
 * live dependents.
 *
 * @remarks
 * Disposing a depended-on node would leave stale edges in the
 * reverse-dependency graph; the contract is that the calling adapter
 * only releases a node after refcount reaches zero (i.e., no live
 * downstream consumer remains). The error names every offending
 * dependent so the caller can debug the leak.
 *
 * @param id - The node the caller attempted to dispose.
 * @param dependents - The ids of every live derived node that still
 *  reads from `id`.
 */
export class NodeHasDependentsError extends CauslError {
  override name = 'NodeHasDependentsError'
  /** Discriminated tag for exhaustive matching. */
  readonly kind = 'NodeHasDependents' as const
  constructor(
    public readonly id: NodeId,
    public readonly dependents: readonly NodeId[],
  ) {
    super(
      `Cannot dispose "${id}" — it still has ${dependents.length} dependent(s): ${dependents.join(', ')}`,
    )
  }
}

/**
 * Raised when {@link Graph.hydrate} receives a snapshot that does
 * not match the live graph's capabilities — either an unsupported
 * `schema` version or a `schemaHash` that diverges from the digest
 * of the currently registered node id-set.
 *
 * @remarks
 * Catches the hydration-mismatch race where the server-snapshot
 * id-set diverges from the client node-set. The check is structural:
 * `schemaHash` is the persistence-side mirror of {@link Graph.subscribe}'s
 * narrow-capability discipline, ensuring a stale or malicious snapshot
 * whose id-set diverges from the live graph is rejected up-front rather
 * than silently tearing engine state. The capability check is structural,
 * not a hope.
 *
 * @param reason - Discriminator: `'schema-version'` rejects an
 *  unsupported wire-format version; `'schema-hash'` rejects a
 *  capability-mismatch on a supported version.
 * @param detail - Human-readable diagnostic appended to the message.
 */
export class HydrationSchemaError extends CauslError {
  override name = 'HydrationSchemaError'
  /** Discriminated tag for exhaustive matching. */
  readonly kind = 'HydrationSchema' as const
  constructor(
    public readonly reason: 'schema-version' | 'schema-hash',
    public readonly detail: string,
  ) {
    super(`Hydration rejected (${reason}): ${detail}`)
  }
}

/**
 * Raised when adapter code attempts to dispose a node while a commit
 * is in progress on the same graph.
 *
 * @remarks
 * The engine lifecycle is one composite statechart with two top-level
 * states for the engine region: `Idle` and `Committing` (which itself
 * decomposes into Staging, Recomputing, Validating, Publishing).
 * Registry edits during the Committing window would race with the
 * recompute / publish phases of the in-flight commit; disposal must
 * wait until the engine returns to Idle. The error names the node so
 * the adapter can defer or queue.
 *
 * @param id - The node the caller attempted to dispose mid-commit.
 */
export class DisposalDuringCommitError extends CauslError {
  override name = 'DisposalDuringCommitError'
  /** Discriminated tag for exhaustive matching. */
  readonly kind = 'DisposalDuringCommit' as const
  constructor(public readonly id: NodeId) {
    super(`Cannot dispose "${id}" while a commit is in progress`)
  }
}

/**
 * Raised when the `assertDeterministicCompute` invariant gate detects
 * a derivation whose `compute(get)` returns a different value on the
 * second call against the same dependency snapshot — i.e. the compute
 * is not a pure function of its declared dependencies (SPEC §15.1).
 *
 * @remarks
 * SPEC §15.1 requires that every derived value satisfy
 * `derived(t) = f(b₁(t), …, bₙ(t))` — a pure function of its
 * dependencies sampled at the same commit moment. The denotational
 * definition forbids hidden inputs: a compute that reads
 * `Math.random()`, `Date.now()`, an external mutable cell, or any
 * value not surfaced through the tracked `get` accessor breaks the
 * equation, because two calls against the same `get` return values
 * disagree.
 *
 * The audit's adversarial-fanin scenario (#718) injects
 * `Math.random()` returns into 0.1% of derivations and asks the
 * engine to detect them. The detection strategy this error tags is
 * second-call equality: after the first compute records its
 * dependencies and a value, the engine re-invokes the compute
 * against an accessor that returns the same upstream values, and
 * compares the second result with the first via `Object.is`. A
 * mismatch is the structural witness of non-determinism.
 *
 * Opt-in via `experimentalFlags: { assertDeterministicCompute: true }`
 * (env var `CAUSL_ASSERT_DETERMINISTIC_COMPUTE=1`). The flag defaults
 * to `false` because the gate doubles `compute()` work; production
 * pays zero cost. The flag is intended for dev / test / CI where the
 * cost is acceptable as the price of a structural invariant gate.
 *
 * The `path` field carries every node id traversed at detection
 * time, ending with the offending node. Mirrors {@link CycleError}'s
 * `path` shape so callers branching on `instanceof CauslError` get a
 * consistent debug surface.
 *
 * @param id - The derived node whose compute returned a different
 *   value on the second call.
 * @param path - Ordered ids from the recompute root down to `id`,
 *   so callers can locate the offending node in a deeper graph.
 */
export class NonDeterministicComputeError extends CauslError {
  override name = 'NonDeterministicComputeError'
  /** Discriminated tag for exhaustive matching. */
  readonly kind = 'NonDeterministicCompute' as const
  constructor(
    public readonly id: NodeId,
    public readonly path: readonly NodeId[],
  ) {
    super(
      `Derived "${id}" is not a deterministic function of its declared ` +
        `dependencies: re-running its compute against the same dep snapshot ` +
        `produced a different value. Path: ${path.join(' → ')}`,
    )
  }
}

/**
 * Raised as **defense-in-depth** when an engine-internal recursive
 * walker exhausts the V8 call stack while populating a
 * freshly-registered derivation's value and dependency set (#936,
 * status post-#956).
 *
 * @remarks
 * The registration path (`graph.derived(...)`) eagerly evaluates a
 * new derivation to populate its value, dep-set, and the reverse-dep
 * adjacency map. After #670 / #705 / #773 / #956, every walker on
 * the registration and commit-time hot paths is iterative end-to-end:
 *
 *   - Registration-time eager evaluation runs through
 *     {@link computeDerivedIterative} (#670), which walks the dep
 *     graph via an explicit `StackFrame[]` rather than recursive
 *     calls, restart-on-miss when an upstream is uncomputed.
 *   - Commit-time Phase D recompute walks the affected sub-graph via
 *     an augmented Kahn pass (#705 / #773); each derivation's
 *     `computeDerived` invocation finds every upstream computed by
 *     topo order, so the recursive `get` accessor's lazy-upstream
 *     branch is never taken in practice.
 *   - Lazy first-read via `readEntry`'s `!e.computed` branch is
 *     unreachable on a graph built through `graph.derived(...)`
 *     because every derived is computed eagerly at registration; it
 *     remains in the source as a defensive fallback for any future
 *     code path that bypasses the registration-time evaluator.
 *
 * Pre-#956 this error was the *expected* normal-path failure mode at
 * depth 10k (PR #943 wired the registration walker's catch-arm to
 * convert V8's raw `RangeError`). Post-#956 the iterative driver
 * lifts the depth ceiling past 12k on Node 22+, so this error
 * becomes a residual-recursion guard rather than the steady-state
 * outcome — kept in the engine because:
 *
 *   1. A user `derived` body whose compute itself recurses outside
 *      the tracker (e.g. a recursive helper closing over a long
 *      dep-chain manually) can still overflow V8 and surface a raw
 *      `RangeError`; converting it preserves the user-facing
 *      contract "no public causl API ever crashes the Node process
 *      with a raw V8 `RangeError`".
 *   2. Stricter `--stack-size` configurations or non-V8 runtimes
 *      may surface stack exhaustion at lower depths; a typed error
 *      keeps the DX symmetric across deployment shapes.
 *   3. The conversion is cheap (one `instanceof` + `String#startsWith`
 *      check inside the `derived(...)` catch arm) and pays nothing on
 *      the hot path.
 *
 * The symmetric DX in the bench is `RecursiveEvalStackOverflowError`
 * (jotai #922, mobx #798, redux #926); those harnesses still gate
 * `linear-chain × 10000` upfront because their walkers stayed
 * recursive — the asymmetry vs causl is the post-#956 bench result.
 *
 * @param id - The derived node id whose registration overflow-converted.
 * @param scale - The observed chain depth at registration time, when
 *   known — otherwise -1. Carried so a caller printing the error
 *   message can locate the offending workload without re-deriving the
 *   shape from the stack trace.
 */
export class DerivedRegistrationStackOverflowError extends CauslError {
  override name = 'DerivedRegistrationStackOverflowError'
  /** Discriminated tag for exhaustive matching. */
  readonly kind = 'DerivedRegistrationStackOverflow' as const
  constructor(
    public readonly id: NodeId,
    public readonly scale: number = -1,
  ) {
    super(
      `Derived "${id}" registration overflowed the V8 call stack — ` +
        `the engine's closure-tracking walker recurses one frame per ` +
        `dep-chain edge and exhausted the stack at depth` +
        (scale >= 0 ? ` ≥ ${scale}` : '') +
        `. The chain is too deep for the recursive registration ` +
        `walker; reduce the chain depth, or split the registration ` +
        `into smaller batches separated by a commit (#936).`,
    )
  }
}

/**
 * Raised when `createCausl({ name })` receives a name that does not
 * match the validity rule `/^[A-Za-z0-9_.:-]{1,256}$/`.
 *
 * @remarks
 * The `name` field is surfaced as `graphId` on every IR record
 * (schema 3 onward). The character set is the intersection of "safe
 * in JSON", "safe in URL fragments", and "safe in filesystem paths" —
 * three places adopters have been observed pasting a graphId. The
 * 256-char cap mirrors the §12.2 teaching-cost cap on public surface
 * names. The engine throws at construction so the failure mode is
 * "the engine could not be built" rather than "a downstream pass
 * failed to read the IR". Refusal is structural; there is no
 * recovery path other than supplying a different name (or omitting
 * `name` and accepting the UUID v4 fallback).
 *
 * @param name - The rejected `name` argument.
 */
export class InvalidGraphNameError extends CauslError {
  override name = 'InvalidGraphNameError'
  /** Discriminated tag for exhaustive matching. */
  readonly kind = 'InvalidGraphName' as const
  constructor(public readonly invalidName: string) {
    super(
      `Invalid graph name: ${JSON.stringify(invalidName)}. ` +
        `Must match /^[A-Za-z0-9_.:-]{1,256}$/.`,
    )
  }
}
