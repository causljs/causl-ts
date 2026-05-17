import { c as NodeId, e as CreateCauslOptions, G as Graph } from './types-BwrLZElV.js';
export { A as AdaptThresholds, f as CAUSL_MODEL_SCHEMA, g as CauslFlags, d as CauslModel, C as Commit, h as Compute, i as CycleExplanation, D as DEFAULT_THRESHOLDS, j as DepFrame, k as DerivedExplanation, l as DerivedNode, E as EngineTelemetry, m as Explanation, n as ExportModelOptions, a as GraphSnapshot, o as GraphStats, b as GraphTime, p as IRBridge, q as IRCallFrame, r as IRCallGraph, s as IRCommit, t as IRDerived, u as IRDispose, v as IREvent, w as IRGraphId, x as IRInput, y as IRNode, z as IRNodeId, B as IRRead, F as IRScope, H as IRSubscribe, J as IRSubscribeCallback, K as IRTxSet, L as IRUnsubscribe, M as InputExplanation, I as InputNode, P as LiveExplanation, N as Node, O as Observer, Q as ObserverErrorContext, S as ObserverErrorHandler, T as ParseResult, R as RetentionResult, V as SimulateResult, W as SimulateResultClean, X as SimulateResultFailed, Y as SubscribeOptions, Z as SubscribeReadsObserver, _ as Tx, U as Unsubscribe, $ as ValueMap, a0 as parseCauslModel, a1 as shouldMigrate } from './types-BwrLZElV.js';

/**
 * @packageDocumentation
 *
 * Structured error classes thrown by `@causl/core` at runtime.
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

/**
 * Base class for every error emitted by the causl engine.
 *
 * @remarks
 * Acts as a tagged-identity root: callers may `instanceof CauslError`
 * to distinguish engine-originated failures from host-thrown errors
 * propagated through observers.
 */
declare class CauslError extends Error {
    name: string;
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
declare class DuplicateNodeError extends CauslError {
    readonly id: NodeId;
    name: string;
    constructor(id: NodeId);
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
declare class UnknownNodeError extends CauslError {
    readonly id: NodeId;
    name: string;
    constructor(id: NodeId);
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
declare class NotAnInputNodeError extends CauslError {
    readonly id: NodeId;
    name: string;
    constructor(id: NodeId);
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
declare class CommitInProgressError extends CauslError {
    name: string;
    constructor();
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
declare class CycleError extends CauslError {
    readonly path: readonly NodeId[];
    name: string;
    constructor(path: readonly NodeId[]);
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
declare class StaleTxError extends CauslError {
    name: string;
    constructor();
}
/**
 * Raised when `read`, `subscribe`, or `tx.set` targets a node that has
 * been disposed via the adapter-layer disposal hook
 * (`@causl/core/internal`'s `dispose`).
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
declare class NodeDisposedError extends CauslError {
    readonly id: NodeId;
    readonly disposedAt: number;
    name: string;
    /** Discriminated tag for exhaustive matching. */
    readonly kind: "NodeDisposed";
    constructor(id: NodeId, disposedAt: number);
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
declare class NodeHasDependentsError extends CauslError {
    readonly id: NodeId;
    readonly dependents: readonly NodeId[];
    name: string;
    /** Discriminated tag for exhaustive matching. */
    readonly kind: "NodeHasDependents";
    constructor(id: NodeId, dependents: readonly NodeId[]);
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
declare class HydrationSchemaError extends CauslError {
    readonly reason: 'schema-version' | 'schema-hash';
    readonly detail: string;
    name: string;
    /** Discriminated tag for exhaustive matching. */
    readonly kind: "HydrationSchema";
    constructor(reason: 'schema-version' | 'schema-hash', detail: string);
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
declare class DisposalDuringCommitError extends CauslError {
    readonly id: NodeId;
    name: string;
    /** Discriminated tag for exhaustive matching. */
    readonly kind: "DisposalDuringCommit";
    constructor(id: NodeId);
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
declare class NonDeterministicComputeError extends CauslError {
    readonly id: NodeId;
    readonly path: readonly NodeId[];
    name: string;
    /** Discriminated tag for exhaustive matching. */
    readonly kind: "NonDeterministicCompute";
    constructor(id: NodeId, path: readonly NodeId[]);
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
declare class DerivedRegistrationStackOverflowError extends CauslError {
    readonly id: NodeId;
    readonly scale: number;
    name: string;
    /** Discriminated tag for exhaustive matching. */
    readonly kind: "DerivedRegistrationStackOverflow";
    constructor(id: NodeId, scale?: number);
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
declare class InvalidGraphNameError extends CauslError {
    readonly invalidName: string;
    name: string;
    /** Discriminated tag for exhaustive matching. */
    readonly kind: "InvalidGraphName";
    constructor(invalidName: string);
}

/**
 * @packageDocumentation
 *
 * Reference implementation of the Causl engine: a deterministic, transactional
 * dependency graph built around a one-page denotational definition. GraphTime is an
 * ordered sequence of commit moments t₀ < t₁ < t₂ < …; an input is a writable
 * Behavior whose value at time `t` is the last write at or before `t`; a derived
 * node is `derived(t) = f(b₁(t), …, bₙ(t))`, a pure function of its dependencies
 * sampled at the *same* time. From those equations glitch-freedom, determinism, and
 * atomicity are theorems rather than goals: there is no intermediate "B updated but
 * C did not" state because there is no intermediate time, two implementations either
 * agree on `f(b₁(t), …, bₙ(t))` or one is wrong, and a transaction creates exactly
 * one new `t` so fractional time does not exist.
 *
 * Two primitives — {@link InputNode} and {@link DerivedNode} — and one operation
 * ({@link Graph.commit | commit}) are everything the engine ships. This module owns
 * every piece of mutable state the runtime needs — the entry table for inputs and
 * derivations, the reverse-dependency adjacency map, the staged-write buffer for the
 * in-flight commit, the per-node and per-commit observer registries, and a bounded
 * commit history that realises the engine's "the transaction log is itself a
 * Behavior" inspection promise. A single mutation surface ({@link Graph.commit})
 * advances {@link GraphTime} by one and drives the recompute fixpoint: dirty inputs
 * seed an affected set over the reverse-dep graph, that set is Kahn-ordered,
 * derivations are evaluated under a tracking `get` that captures dynamic
 * dependencies, and equality cutoffs (`Object.is`) prune downstream work and
 * silence redundant subscriber notifications. Errors thrown inside observers are
 * isolated through {@link ObserverErrorHandler} so a faulty subscriber cannot abort
 * the commit pipeline. The surface returned by {@link createCausl} realises the
 * canonical primitives — `input`, `derived`, `commit`, `read`, `subscribe`,
 * `subscribeCommits`, `explain` — plus the second-tier extensions (`commitLog`,
 * `exportModel`, `simulate`, `snapshot`, `hydrate`, `readAt`, `now`) that each
 * justify a slot by naming a concept the engine cannot otherwise express.
 */

/**
 * Regex pattern for valid `graphId` values.
 *
 * @remarks
 * Per SPEC.md §16.2.1.5, the intersection of "safe in JSON",
 * "safe in URL fragments", and "safe in filesystem paths". The
 * runtime validator (`createCausl({ name })`) and the schema-3
 * migration codemod both consume this constant so a regex drift
 * between them is impossible by construction. A unit test asserts
 * the source string is exactly `^[A-Za-z0-9_.:-]{1,256}$` to catch
 * a future PR that loosens the constraint without coordinating.
 */
declare const GRAPH_ID_REGEX: RegExp;
/**
 * Construct a fresh Causl graph at GraphTime t₀ = 0.
 *
 * Implements the canonical primitive surface — `input`, `derived`, `commit`,
 * `read`, `subscribe`, `subscribeCommits`, `explain` — plus the second-tier
 * extensions `commitLog`, `exportModel`, `simulate`, `snapshot`, `snapshotAt`,
 * `hydrate`, `readAt`, and the `now` accessor. Each non-canonical
 * row earned its slot by naming a concept the engine cannot otherwise express:
 * the commit log realises the "transaction log is a Behavior" promise; export
 * is the bridge to the bounded model checker; `simulate` is the §5 dry-run
 * API that lets a caller predict a commit's effect without committing;
 * snapshot/hydrate/readAt are SSR
 * transfer, persistence, and time-travel; `now` lets external observers ask
 * "what time is it?" without firing a commit.
 *
 * @param options - Engine-wide knobs: history cap and observer-error handler.
 * @returns A {@link Graph} instance whose lifetime is owned by the caller.
 *
 * @remarks
 * The closure returned here owns every piece of mutable state the engine
 * touches. There is no module-level state and no implicit singleton — each
 * call yields an independent universe with its own GraphTime. This is the
 * smallest example the engine must support: an input, a derivation, a
 * subscription, and a commit that fires exactly one notification when the
 * downstream value actually changes. If this works, the engine is real;
 * everything else is downstream of getting it right.
 *
 * @example
 * ```ts
 * const graph = createCausl()
 * const a = graph.input('a', 1)
 * const b = graph.input('b', 2)
 * const sum = graph.derived('sum', (get) => get(a) + get(b))
 * graph.subscribe(sum, (v) => console.log(v)) // 3
 * graph.commit('bump', tx => tx.set(a, 10))   // 12
 * ```
 */
declare function createCausl(options?: CreateCauslOptions): Graph;

/**
 * @packageDocumentation
 *
 * JSON Schema (Draft-07) describing the {@link CauslModel} IR
 * defined in `./ir.ts`. Authoritative wire-format contract for the
 * boundary between the TypeScript engine and the Rust
 * `causl-check` binary — the bounded model checker that consumes
 * the IR and enumerates reachable states within configurable bounds
 * (`--max-nodes`, `--max-commits`). The Rust crate regenerates an
 * equivalent schema via `serde_json` / `schemars` whenever the IR
 * shape changes; this document and the Rust schema are kept in
 * lock-step so a mismatch is caught up-front rather than turning
 * into a silent model-decoding bug.
 *
 * Two-primitive discipline (§4). The schema closes the `nodes` array
 * over exactly two `kind` constants — `'input'` and `'derived'` — and
 * forbids additional top-level properties via `additionalProperties:
 * false`. The earlier draft of this document advertised optional
 * `resources`, `conflicts`, and `msgs` arrays each carrying its own
 * `kind` constant; that surface taught downstream consumers (Rust
 * checker, generated bindings, schema-derived types) the eleven-kind
 * taxonomy §4 was written to refuse, and was removed in #359.
 */
/**
 * Draft-07 JSON Schema document for the CauslModel IR.
 *
 * @remarks
 * The schema is `as const` so consumers can derive a precise literal
 * type ({@link CauslModelJsonSchema}) for compile-time validation
 * tooling. Validation libraries (Ajv, etc.) accept the value
 * directly at runtime.
 *
 * Schema 3 (PR-B1). Every node and commit carries `graphId` (the
 * multi-graph foreign key); the top-level document also carries the
 * `events` lifecycle stream, the `scopes` registry resolved by
 * `IRSubscribe.scopeId`, and the `bridges` allowlist consumed by
 * EPIC-2's `CrossGraphRead` pass. Each event variant is closed under
 * `oneOf` over its `kind` discriminator — `subscribe`,
 * `subscribe-callback`, `unsubscribe`, `dispose`, `read`, `tx-set`.
 *
 * @see {@link CAUSL_MODEL_SCHEMA}
 */
declare const causlModelJsonSchema: {
    readonly $schema: "http://json-schema.org/draft-07/schema#";
    readonly $id: "https://causl.dev/schemas/causl-model-v3.json";
    readonly title: "CauslModel";
    readonly type: "object";
    readonly required: readonly ["schema", "time", "nodes", "commits", "events", "scopes", "bridges"];
    readonly additionalProperties: false;
    readonly properties: {
        readonly schema: {
            readonly const: 3;
        };
        readonly time: {
            readonly type: "integer";
            readonly minimum: 0;
        };
        readonly nodes: {
            readonly type: "array";
            readonly items: {
                readonly oneOf: readonly [{
                    readonly type: "object";
                    readonly required: readonly ["kind", "id", "graphId", "value", "serializable"];
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly kind: {
                            readonly const: "input";
                        };
                        readonly id: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly graphId: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly value: {};
                        readonly serializable: {
                            readonly type: "boolean";
                        };
                    };
                }, {
                    readonly type: "object";
                    readonly required: readonly ["kind", "id", "graphId", "deps", "conditionalDeps", "value", "serializable"];
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly kind: {
                            readonly const: "derived";
                        };
                        readonly id: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly graphId: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly deps: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly conditionalDeps: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "string";
                            };
                        };
                        readonly value: {};
                        readonly serializable: {
                            readonly type: "boolean";
                        };
                    };
                }];
            };
        };
        readonly commits: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly required: readonly ["time", "graphId", "intent", "changedNodes"];
                readonly additionalProperties: false;
                readonly properties: {
                    readonly time: {
                        readonly type: "integer";
                        readonly minimum: 0;
                    };
                    readonly graphId: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly intent: {
                        readonly type: "string";
                    };
                    readonly changedNodes: {
                        readonly type: "array";
                        readonly items: {
                            readonly type: "string";
                        };
                    };
                    readonly originatedAt: {
                        readonly type: "integer";
                        readonly minimum: 0;
                    };
                    readonly callGraph: {
                        readonly type: "object";
                        readonly required: readonly ["frames", "truncatedDeeper"];
                        readonly additionalProperties: false;
                        readonly properties: {
                            readonly frames: {
                                readonly type: "array";
                            };
                            readonly truncatedDeeper: {
                                readonly type: "boolean";
                            };
                        };
                    };
                    readonly originEvent: {
                        readonly type: "string";
                    };
                };
            };
        };
        readonly events: {
            readonly type: "array";
            readonly items: {
                readonly oneOf: readonly [{
                    readonly type: "object";
                    readonly required: readonly ["kind", "graphId", "id", "scopeId", "target", "callbackSite", "time"];
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly kind: {
                            readonly const: "subscribe";
                        };
                        readonly graphId: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly id: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly scopeId: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly target: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly callbackSite: {
                            readonly type: "string";
                        };
                        readonly time: {
                            readonly type: "integer";
                            readonly minimum: 0;
                        };
                    };
                }, {
                    readonly type: "object";
                    readonly required: readonly ["kind", "graphId", "id", "subscribeId", "firedAt"];
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly kind: {
                            readonly const: "subscribe-callback";
                        };
                        readonly graphId: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly id: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly subscribeId: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly firedAt: {
                            readonly type: "integer";
                            readonly minimum: 0;
                        };
                    };
                }, {
                    readonly type: "object";
                    readonly required: readonly ["kind", "graphId", "id", "scopeId", "time"];
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly kind: {
                            readonly const: "unsubscribe";
                        };
                        readonly graphId: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly id: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly scopeId: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly time: {
                            readonly type: "integer";
                            readonly minimum: 0;
                        };
                    };
                }, {
                    readonly type: "object";
                    readonly required: readonly ["kind", "graphId", "nodeId", "scopeId", "time", "disposeAt"];
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly kind: {
                            readonly const: "dispose";
                        };
                        readonly graphId: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly nodeId: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly scopeId: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly time: {
                            readonly type: "integer";
                            readonly minimum: 0;
                        };
                        readonly disposeAt: {
                            readonly type: "array";
                            readonly items: {
                                readonly type: "integer";
                                readonly minimum: 0;
                            };
                        };
                    };
                }, {
                    readonly type: "object";
                    readonly required: readonly ["kind", "graphId", "derivedId", "readNodeId", "time", "seq", "truncated"];
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly kind: {
                            readonly const: "read";
                        };
                        readonly graphId: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly derivedId: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly readNodeId: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly time: {
                            readonly type: "integer";
                            readonly minimum: 0;
                        };
                        readonly seq: {
                            readonly type: "integer";
                            readonly minimum: 0;
                        };
                        readonly truncated: {
                            readonly type: "boolean";
                        };
                    };
                }, {
                    readonly type: "object";
                    readonly required: readonly ["kind", "graphId", "inputId", "time"];
                    readonly additionalProperties: false;
                    readonly properties: {
                        readonly kind: {
                            readonly const: "tx-set";
                        };
                        readonly graphId: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly inputId: {
                            readonly type: "string";
                            readonly minLength: 1;
                        };
                        readonly time: {
                            readonly type: "integer";
                            readonly minimum: 0;
                        };
                    };
                }];
            };
        };
        readonly scopes: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly required: readonly ["id", "kind", "lifetime"];
                readonly additionalProperties: false;
                readonly properties: {
                    readonly id: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly kind: {
                        readonly enum: readonly ["ephemeral", "infinite", "process-exit"];
                    };
                    readonly lifetime: {
                        readonly type: "object";
                        readonly required: readonly ["origin", "terminator"];
                        readonly additionalProperties: false;
                        readonly properties: {
                            readonly origin: {
                                readonly type: "string";
                            };
                            readonly terminator: {
                                readonly type: "string";
                            };
                        };
                    };
                };
            };
        };
        readonly bridges: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly required: readonly ["from", "to", "dep", "policy"];
                readonly additionalProperties: false;
                readonly properties: {
                    readonly from: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly to: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly dep: {
                        readonly type: "string";
                        readonly minLength: 1;
                    };
                    readonly policy: {
                        readonly enum: readonly ["legacy-allow", "test-only", "read-only"];
                    };
                };
            };
        };
    };
};
/**
 * Compile-time literal type of {@link causlModelJsonSchema}.
 *
 * @remarks
 * Useful for downstream tooling that wants to derive precise types
 * from the schema document (e.g. `json-schema-to-ts`).
 */
type CauslModelJsonSchema = typeof causlModelJsonSchema;

/**
 * @packageDocumentation
 *
 * Pluggable bridge between JS and the WASM-backed engine.
 *
 * @remarks
 * The JS↔WASM boundary is the dominant cost in WebAssembly-backed
 * reactive engines: every commit serialises JS values to UTF-8 JSON,
 * walks them through `serde_json`, and reverses the process on the way
 * out. For a 100k-node graph that is approximately 10⁶–10⁷ allocations
 * per commit on marshalling alone — and most of those go to two
 * operations: object construction/destruction and string copying.
 *
 * Two newer Wasm proposals collapse those costs:
 *
 * - **WasmGC** (Chromium 119+, Firefox 120+, Node 22.6+) — `externref`
 *   reference types let WASM hold GC-managed JS object references
 *   without serialisation.
 * - **JS String Builtins** (Wasm CG Phase 4 / Wasm 3.0; Chrome 131,
 *   Firefox 130+, Node 22.6+) — direct imports for JS string
 *   operations via `(import "wasm:js-string" "length" ...)`. Strings
 *   stay JS-side; no UTF-8 copy.
 *
 * Host support varies — legacy Node, older Safari, embedded runtimes
 * lack one or both. The bridge between JS and WASM is therefore
 * **pluggable**: pick the fastest combination the host actually
 * supports, fall back transparently otherwise.
 *
 * This module ships **only the TypeScript-side abstraction** — the
 * `Bridge` interface, the `BridgeFeatures` capability flags, the
 * `detectBridge()` harness that probes the host, and a placeholder
 * `serde-json` bridge that always succeeds. The two real bridge
 * implementations land in dedicated PRs:
 *
 * - #692 — WasmGC + JS String Builtins (dual artifact: builtins +
 *   classic fallback)
 * - #693 — `serde_json` + UTF-8 fallback bridge
 *
 * Until those land, `detectBridge()` returns the universal
 * placeholder. Consumers can program against the interface today; when
 * the implementations ship, no consumer code changes.
 *
 * The interface is intentionally over-specified to preserve seams for
 * proposals not yet baseline:
 *
 * - {@link BridgeFeatures.sharedMemory} — flagged today, no consumers.
 *   When the threading EPIC opens, a `SharedMemoryBridge` slot already
 *   exists in `detectBridge()`. Threading is no longer an
 *   "architectural rewrite"; it is a fourth bridge.
 * - {@link BridgeFeatures.stringView} — flagged today, future
 *   `wasm:string-view` bridge slot. Loader can probe
 *   `wasm:string-view`/`length` analogous to the JS String Builtins
 *   probe.
 * - {@link CodeUnitIndex} / {@link CodePointIndex} newtypes —
 *   committed in the public API now. When `wasm:string-view` lands
 *   (code-point native), only the bridge implementation changes;
 *   consumers' index types stay correct.
 * - {@link Bridge.abiVersion} — bumped on any ABI-breaking bridge
 *   change. The Rust side ships
 *   `#[link_section = ".bridge_abi_version"] static ABI_VERSION: u8 = N;`;
 *   the JS loader reads the section before instantiation; mismatched
 *   bridges fail-closed with a clear error.
 */
/**
 * Capability flags reported by a {@link Bridge} implementation.
 *
 * @remarks
 * Each flag corresponds to a Wasm or host-platform proposal that — if
 * present — collapses a layer of marshalling cost on the JS↔WASM
 * boundary. The flags are surfaced on the interface (rather than
 * inferred from `Bridge.id`) so consumers can branch on the
 * capability they care about without enumerating bridge identities,
 * and so future bridges with novel mixes of capabilities slot in
 * without churning the type.
 */
interface BridgeFeatures {
    /**
     * WasmGC reference types (`externref` / `ref.null any`). When true,
     * the bridge can hold GC-managed JS object references inside WASM
     * tables without serialising them to JSON.
     */
    readonly gc: boolean;
    /**
     * JS String Builtins — direct imports of JS string operations from
     * the `wasm:js-string` import module. When true, the bridge avoids
     * the UTF-8 round-trip for strings that cross the boundary.
     */
    readonly jsStringBuiltins: boolean;
    /**
     * SharedArrayBuffer + Atomics + `WebAssembly.Memory({ shared: true })`.
     * Reserved for the future threading EPIC; no consumers today, but
     * surfaced so the multi-threaded bridge fits the same interface.
     */
    readonly sharedMemory: boolean;
    /**
     * `wasm:string-view` — the proposal that exposes JS string slices
     * to Wasm with code-point-native indexing. Reserved for the future
     * string-view bridge; no consumers today.
     */
    readonly stringView: boolean;
}
/**
 * Branded UTF-16 code-unit index (the JS String addressing model).
 *
 * @remarks
 * JS strings are UTF-16 code-unit sequences, so all current string
 * bridges index by code unit. The brand keeps the public API stable
 * when a future `wasm:string-view` bridge introduces a code-point
 * addressing path: the index newtype stays correct on the consumer
 * side because the type is structurally distinct from a plain
 * `number`.
 */
type CodeUnitIndex = number & {
    readonly __brand: 'CodeUnit';
};
/**
 * Branded Unicode code-point index.
 *
 * @remarks
 * Reserved for the future `wasm:string-view` bridge, which is
 * code-point-native. Surfaced today so the public API does not change
 * shape when the bridge upgrades.
 */
type CodePointIndex = number & {
    readonly __brand: 'CodePoint';
};
/**
 * Opaque handle to a JS object that the bridge has registered with
 * the WASM module.
 *
 * @remarks
 * The shape (an integer slot id, a GC root token, an `externref`)
 * varies by bridge. Consumers must treat the handle as opaque and
 * round-trip it only through {@link Bridge.fromWasmObject} and
 * {@link Bridge.release}.
 */
interface WasmObjectHandle {
    readonly __kind: 'WasmObjectHandle';
}
/**
 * Opaque handle to a JS string the bridge has registered with the
 * WASM module.
 *
 * @remarks
 * As with {@link WasmObjectHandle}, the shape varies by bridge —
 * UTF-8 length-prefixed pointer, slot id, `externref` of the JS
 * string, future `stringref` — and the handle is opaque to the
 * caller.
 */
interface WasmStringHandle {
    readonly __kind: 'WasmStringHandle';
}
/**
 * Discriminated union of every handle a bridge may issue.
 *
 * @remarks
 * `release()` accepts any handle the bridge has issued; the union
 * keeps the call site honest without forcing each kind through a
 * separate method.
 */
type WasmHandle = WasmObjectHandle | WasmStringHandle;
/**
 * Stable identifier for the three baseline bridges plus a
 * forward-compatible escape hatch for future bridges (`shared-memory`,
 * `string-view`, …) that land against the same interface.
 */
type BridgeId = 'wasmgc-builtins' | 'wasmgc-classic' | 'serde-json' | (string & {
    readonly __brand?: 'FutureBridge';
});
/**
 * Pluggable JS↔WASM boundary contract.
 *
 * @remarks
 * Every bridge in the matrix — `wasmgc-builtins` (#692),
 * `wasmgc-classic` (#692 fallback artifact), `serde-json` (#693), and
 * any future bridge (e.g. `shared-memory` for the threading EPIC) —
 * implements this interface. The {@link BackendEngine} consumes only
 * the interface; bridges are interchangeable at runtime.
 *
 * Two operations dominate boundary cost — object construction and
 * string copying — so they are the only two crossings the interface
 * exposes as primitives. Numbers and booleans pass through cheaply
 * (8 bytes / 4 bytes respectively) and need no bridge primitive.
 */
interface Bridge {
    /**
     * Stable identifier for telemetry and benchmarking. The three
     * baseline ids are `wasmgc-builtins`, `wasmgc-classic`, and
     * `serde-json`; future bridges add new ids without deprecating
     * existing ones.
     */
    readonly id: BridgeId;
    /**
     * Capability flags this bridge advertises. Consumers branch on the
     * flag, not the {@link Bridge.id}.
     */
    readonly features: BridgeFeatures;
    /**
     * ABI version, bumped on any ABI-breaking bridge change. The
     * Rust-side `.bridge_abi_version` linker section is read by the
     * loader and matched against this number; a mismatch fails-closed
     * before the WASM module is instantiated.
     */
    readonly abiVersion: number;
    /**
     * Register a JS object with the WASM module and return an opaque
     * handle.
     */
    toWasmObject(o: object): WasmObjectHandle;
    /**
     * Resolve an opaque object handle back to its JS object.
     */
    fromWasmObject(h: WasmObjectHandle): object;
    /**
     * Register a JS string with the WASM module and return an opaque
     * handle. The bridge owns the allocation; callers must
     * {@link Bridge.release} it when done.
     *
     * Result strings are allocated through the bridge's allocator so a
     * future `wasm:string-view` bridge can substitute its own without
     * changing the consumer surface.
     */
    toWasmString(s: string): WasmStringHandle;
    /**
     * Resolve an opaque string handle back to a JS string.
     *
     * The returned string is a plain JS `string` even when the bridge
     * keeps the underlying buffer in WASM linear memory; the bridge
     * never leaks `JsValue` (or any wasm-bindgen wrapper) into bridge
     * consumers.
     */
    fromWasmString(h: WasmStringHandle): string;
    /**
     * Release a handle previously issued by this bridge. Idempotent;
     * releasing an unknown or already-released handle is a no-op.
     */
    release(h: WasmHandle): void;
}
/**
 * Probe each {@link BridgeFeatures} capability in turn.
 *
 * @remarks
 * Probes are runtime, not build-time, so a host that newly enables
 * GC (or flips an experimental flag on the next page load) picks up
 * the fast bridge automatically. Each probe is cheap: a 12-byte
 * module compilation plus a `WebAssembly.compile` rejection check.
 *
 * The probes are:
 *
 * 1. **WasmGC** — try compiling a tiny module that uses
 *    `ref.null any`. If `WebAssembly.compile` rejects, no GC.
 * 2. **JS String Builtins** — try compiling a module that imports
 *    `wasm:js-string.length`. If rejected, no String Builtins.
 * 3. **Shared memory** — check `crossOriginIsolated` and probe
 *    `new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true })`.
 * 4. **String view** — try compiling a module that imports
 *    `wasm:string-view`. If rejected, no string-view (the common case
 *    today; no host has shipped string-view yet).
 *
 * The probes catch any thrown exception and report `false` for that
 * capability — feature detection failures are never fatal.
 *
 * @internal Surface kept narrow so the test suite can override
 * individual probes via {@link detectBridge}'s feature override.
 */
declare function detectFeatures(): Promise<BridgeFeatures>;
/**
 * Pick the highest-tier bridge available on the current host.
 *
 * @remarks
 * Selection order:
 *
 * 1. If `CAUSL_WASM_BRIDGE=serde`, return the `serde-json` bridge.
 * 2. If `CAUSL_WASM_BRIDGE=gc` or the host advertises both
 *    {@link BridgeFeatures.gc} and
 *    {@link BridgeFeatures.jsStringBuiltins}, attempt to load the
 *    `wasmgc-builtins` bridge; on instantiation failure fall through.
 * 3. If only {@link BridgeFeatures.gc} is available, attempt to load
 *    the `wasmgc-classic` bridge; on failure fall through.
 * 4. Otherwise return the universal `serde-json` bridge.
 *
 * Tier table per #680's browser-compat audit:
 *
 * | Tier | Hosts                                              | Bridge            |
 * | ---- | -------------------------------------------------- | ----------------- |
 * | A    | Chromium 131+, Firefox 130+, Node 22.6+            | `wasmgc-builtins` |
 * | B    | Safari 18.2+ (GC yes, builtins uncertain)          | `wasmgc-classic`  |
 * | C    | Cloudflare Workers, Vercel Edge, Deno Deploy       | `serde-json`      |
 * | D    | Node 18 LTS, anything pre-GC                       | `serde-json`      |
 *
 * **STUB BEHAVIOUR (current PR).** Until #692 and #693 land the real
 * bridges, this function always returns a {@link makeSerdeJsonPlaceholder}
 * regardless of host capabilities. The probes still run (they
 * exercise the harness on the real hosts that the CI matrix covers),
 * but their results are recorded only on the returned bridge's
 * {@link BridgeFeatures} for telemetry; the bridge identity stays
 * `serde-json`. When the real bridges land, the
 * `loadGcBridge()` / `loadSerdeBridge()` hooks below switch to
 * dynamic-import-based loaders and the function's return type does
 * not change.
 *
 * Feature-detection failures never crash: the harness always returns
 * *some* bridge — the universal fallback if every probe rejects.
 */
declare function detectBridge(): Promise<Bridge>;

/**
 * @packageDocumentation
 *
 * Public-surface barrel for `@causl/core`.
 *
 * Re-exports the canonical seven-method API — `createCausl`,
 * `graph.input`, `graph.derived`, `graph.commit`, `graph.read`,
 * `graph.subscribe`, `graph.explain` — together with the second-tier
 * extensions justified individually on the `Graph` interface
 * (`subscribeCommits`, `commitLog`, `exportModel`, `simulate`,
 * `snapshot`, `hydrate`, `readAt`, `snapshotAt`, `now`), the structured error classes
 * for the race-class catalogue, and the CauslModel IR plus its
 * JSON Schema document — the bridge from the TypeScript engine to the
 * Rust `causl-check` bounded model checker.
 *
 * Consumers should rely on this barrel; deep imports into individual
 * modules are not part of the supported surface.
 */

/**
 * Package version identifier.
 *
 * @remarks
 * Updated by the release tooling; pinned at `0.0.0` during the
 * pre-release phase covered by the current epic.
 */
declare const VERSION = "0.0.0";

export { type Bridge, type BridgeFeatures, type BridgeId, CauslError, type CauslModelJsonSchema, type CodePointIndex, type CodeUnitIndex, CommitInProgressError, CreateCauslOptions, CycleError, DerivedRegistrationStackOverflowError, DisposalDuringCommitError, DuplicateNodeError, GRAPH_ID_REGEX, Graph, HydrationSchemaError, InvalidGraphNameError, NodeDisposedError, NodeHasDependentsError, NodeId, NonDeterministicComputeError, NotAnInputNodeError, StaleTxError, UnknownNodeError, VERSION, type WasmHandle, type WasmObjectHandle, type WasmStringHandle, causlModelJsonSchema, createCausl, detectBridge, detectFeatures };
