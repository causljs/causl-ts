import { Graph, Node, GraphSnapshot } from '@causl/core';
import * as react from 'react';
import { ReactNode, JSX } from 'react';
import { ReadOnlyGraph } from '@causl/core/internal';
import { ResourceState } from '@causl/sync';

/**
 * @packageDocumentation
 *
 * MVU-shaped runner for Causl. The module defines the {@link Update}
 * contract — a function from `(Msg, Graph)` to `void` — and two helpers
 * around it: {@link runMessages} for sequencing a message list (tests,
 * replays) and {@link createUpdate} for assembling a runner from
 * per-tag handlers keyed off a discriminated `Msg` union.
 *
 * Transactions are the engine room; messages are the front door.
 * Application developers think "the user clicked Save," not "I will
 * mutate `cell:wb1:Sheet1:A1`," so the `Msg` discriminated union is
 * the surface where the type system enforces "make impossible states
 * impossible." Status, conflicts, and explanations are values
 * selectable from the same `Graph` — they do not need their own
 * dispatch surfaces.
 *
 *   type Msg = EditCell | SelectRange | StartDrawing | ...
 *
 *   const update: Update<Msg> = (msg, graph) => {
 *     switch (msg.kind) {
 *       case 'edit-cell':
 *         graph.commit('edit-cell', tx => tx.set(cell(msg.ref), msg.value))
 *         return
 *       ...
 *     }
 *   }
 */

/**
 * The MVU runner's call signature: a function that, given a `Msg` and
 * the current `Graph`, performs exactly one `graph.commit(...)` and
 * returns nothing.
 *
 * @typeParam Msg - The application's message union.
 * @typeParam G - The graph subtype, defaulting to {@link Graph}.
 *
 * @remarks
 * `Graph` is a stable handle whose `now` advances by exactly one tick
 * per `commit`; the runner does not reconstruct it. The function
 * returns `void` because the return value carries no information — the
 * caller already holds the same handle, and forgetting to return it
 * (the prior `(msg, g) => g` shape) would yield `undefined` and crash
 * the next dispatch. The new shape is imperative-by-design: the
 * handler issues `graph.commit(...)`, end of story.
 */
type Update<Msg, G extends Graph = Graph> = (msg: Msg, graph: G) => void;
/**
 * Sequence a list of messages against a single graph instance.
 *
 * @typeParam Msg - The application's message union.
 * @typeParam G - The graph subtype.
 *
 * @param update - The runner that handles a single message.
 * @param graph - The graph handle to drive.
 * @param messages - Messages applied in order.
 * @returns The same graph handle, after every message has been applied.
 *
 * @remarks
 * Useful for tests and replays; in normal application code dispatch
 * happens via `useDispatch()` (see `useDispatch.ts`). Each message
 * still produces exactly one commit — `commit` is the only way time
 * advances, and it advances by exactly one `GraphTime` per call —
 * so `runMessages` deliberately does not batch them. The sequence
 * `[msg1, msg2, msg3]` produces three discrete commits, each with
 * its own intent label, each fully observable in the commit log. The
 * graph handle is returned for caller convenience (chain into a
 * `graph.read(...)`); the handle's identity is unchanged.
 *
 * @example
 * ```ts
 * const final = runMessages(update, graph, [msg1, msg2, msg3])
 * ```
 */
declare function runMessages<Msg, G extends Graph = Graph>(update: Update<Msg, G>, graph: G, messages: readonly Msg[]): G;
/**
 * Construct a typed {@link Update} from a discriminator key plus a
 * record of per-tag handlers.
 *
 * @typeParam Msg - The application's message union; must have a
 * `kind` discriminator string.
 * @typeParam G - The graph subtype.
 * @typeParam Handlers - Record of handlers keyed by `Msg['kind']`,
 * each receiving the narrowed message variant for its tag.
 *
 * @param handlers - Map from message tag to a handler that issues
 * `graph.commit(...)`.
 * @returns An {@link Update} runner that dispatches to the matching
 * handler.
 * @throws Error when an incoming message's `kind` has no registered
 * handler.
 *
 * @remarks
 * Each handler is responsible for issuing `graph.commit(...)` itself.
 * Handlers return `void` — the engine's commit is a side-effecting
 * method on the graph handle, so the runner is imperative by design.
 * The exhaustiveness of the `Handlers` type is enforced by the
 * mapped-type constraint on `Msg['kind']` — adding a new tag to `Msg`
 * without a handler is a compile error at the call site.
 *
 * @example
 * ```ts
 * type Msg =
 *   | { kind: 'set-a'; value: number }
 *   | { kind: 'set-b'; value: number }
 *
 * const update = createUpdate<Msg>({
 *   'set-a': (msg, g) => { g.commit('set-a', tx => tx.set(a, msg.value)) },
 *   'set-b': (msg, g) => { g.commit('set-b', tx => tx.set(b, msg.value)) },
 * })
 * ```
 */
declare function createUpdate<Msg extends {
    kind: string;
}, G extends Graph = Graph, Handlers extends {
    [K in Msg['kind']]: (msg: Extract<Msg, {
        kind: K;
    }>, graph: G) => void;
} = {
    [K in Msg['kind']]: (msg: Extract<Msg, {
        kind: K;
    }>, graph: G) => void;
}>(handlers: Handlers): Update<Msg, G>;

/**
 * @packageDocumentation
 *
 * Typed `Msg` discriminated-union helper for the §8 MVU surface
 * (closes #369). Application developers don't think "I will mutate
 * `cell:wb1:Sheet1:A1`," they think "the user clicked Save." The
 * `Msg` union is the application-facing front door, and §9's "make
 * impossible states impossible" applies *here* — at the dispatch
 * boundary — not in 57 internal enum tags.
 *
 * Before this module the engine contributed only the `Msg extends
 * { kind: string }` constraint inside `createUpdate`'s generics: a
 * name (`kind`), nothing else. Users hand-rolled the discriminated
 * union, hand-rolled the variant constructors, and reached for
 * `assertNever` themselves. Adding a tag without a handler caught
 * the dispatch site, but adding a tag without updating the union
 * silently drifted.
 *
 * The helper exposed here closes that surface:
 *
 *   - {@link Msg} — generic variant template; `Msg<'inc'>` produces
 *     `{ kind: 'inc' }` with no payload, `Msg<'set', { value: number }>`
 *     produces `{ kind: 'set'; value: number }`.
 *   - {@link defineMsgs} — record-of-payloads builder that returns a
 *     typed factory plus a phantom `_union` field carrying the closed
 *     `Msg` union. Pair the record-of-payloads with `createUpdate`'s
 *     record-of-handlers and the same shape declares both sides.
 *   - {@link MsgOf} — extractor pulling the closed union back out of
 *     a builder so consumers can name the parameter type explicitly.
 *   - {@link assertNever} — exhaustiveness probe; the canonical
 *     `default` arm in a `switch (msg.kind)`.
 *
 * Pairing with `createUpdate` (the MVU runner factory):
 *
 * ```ts
 * const msg = defineMsgs({
 *   inc: null,
 *   dec: null,
 *   set: payload<{ value: number }>(),
 * })
 * type CounterMsg = MsgOf<typeof msg>
 *
 * const update = createUpdate<CounterMsg>({
 *   inc: (_m, g) => { g.commit('inc', tx => ...) },
 *   dec: (_m, g) => { g.commit('dec', tx => ...) },
 *   set: (m, g) => { g.commit('set', tx => tx.set(n, m.value)) },
 * })
 *
 * dispatch(msg.inc())            // { kind: 'inc' }
 * dispatch(msg.set({ value: 3 })) // { kind: 'set'; value: 3 }
 * ```
 *
 * Adding a fourth tag to the `defineMsgs` record without adding a
 * matching handler is a compile error at the `createUpdate` call
 * site (same exhaustiveness gate as before). Adding a fourth tag
 * without naming it in a `switch (msg.kind)` is a compile error at
 * the `assertNever(msg)` default arm. Both gates fail closed.
 */
/**
 * Variant template for a discriminated `Msg` union. `Msg<TKind>`
 * produces a payload-less `{ kind: TKind }`; `Msg<TKind, TPayload>`
 * intersects an additional payload object.
 *
 * @typeParam TKind - The literal tag string identifying this variant.
 * @typeParam TPayload - Additional payload object merged into the
 * variant. Defaults to `void` for the no-payload case.
 *
 * @example
 * ```ts
 * type CounterMsg =
 *   | Msg<'inc'>
 *   | Msg<'dec'>
 *   | Msg<'set', { value: number }>
 * ```
 */
type Msg<TKind extends string, TPayload = void> = [TPayload] extends [void] ? {
    readonly kind: TKind;
} : {
    readonly kind: TKind;
} & TPayload;
/**
 * Phantom marker brand carrying the payload type at the type level.
 * Not constructed by user code; produced exclusively by {@link payload}.
 */
interface PayloadMarker<P extends object> {
    readonly __payload: P;
}
/**
 * Phantom payload marker used to declare the payload type for a
 * named variant inside {@link defineMsgs}. Returns a no-op token
 * the builder uses to type-thread its variant constructors. The
 * payload object itself is never instantiated at runtime — the
 * helper only forwards the `kind` plus the user-supplied payload.
 *
 * @typeParam P - The payload object type for the variant.
 *
 * @example
 * ```ts
 * const msg = defineMsgs({
 *   set: payload<{ value: number }>(),
 *   reset: null,
 * })
 * ```
 */
declare function payload<P extends object>(): PayloadMarker<P>;
/**
 * Spec object accepted by {@link defineMsgs}. Each key is a variant
 * tag; each value is either `null` (no payload) or a {@link payload}
 * marker carrying the payload type.
 */
type MsgSpec = {
    readonly [K in string]: null | PayloadMarker<object>;
};
/**
 * Variant constructor record returned by {@link defineMsgs}. For
 * each tag the spec defined as `null`, the entry is a zero-arg
 * function returning `{ kind }`. For each tag with a payload marker,
 * the entry takes the payload object and returns `{ kind, ...payload }`.
 *
 * @typeParam Spec - The spec object passed to {@link defineMsgs}.
 *
 * @remarks
 * The record also carries a phantom `_union` field whose type is the
 * closed `Msg` union for the spec. {@link MsgOf} reads that field; it
 * exists only at the type level and is `undefined` at runtime.
 */
type MsgBuilder<Spec extends MsgSpec> = {
    readonly [K in keyof Spec & string]: Spec[K] extends PayloadMarker<infer P> ? (payload: P) => Msg<K, P> : () => Msg<K>;
} & {
    /**
     * Phantom field carrying the closed `Msg` union for the spec.
     * Read with {@link MsgOf}. Always `undefined` at runtime.
     */
    readonly _union: {
        [K in keyof Spec & string]: Spec[K] extends PayloadMarker<infer P> ? Msg<K, P> : Msg<K>;
    }[keyof Spec & string];
};
/**
 * Extract the closed `Msg` union from a builder produced by
 * {@link defineMsgs}.
 *
 * @typeParam B - A builder returned by {@link defineMsgs}.
 *
 * @example
 * ```ts
 * const msg = defineMsgs({ inc: null, set: payload<{ value: number }>() })
 * type CounterMsg = MsgOf<typeof msg>
 * //   ^? { kind: 'inc' } | { kind: 'set'; value: number }
 * ```
 */
type MsgOf<B extends {
    readonly _union: unknown;
}> = B['_union'];
/**
 * Build a typed variant-constructor record plus closed `Msg` union
 * from a record of `tag → payload?` declarations. The same record
 * shape pairs cleanly with `createUpdate`'s record-of-handlers, so
 * tags are declared once.
 *
 * @typeParam Spec - The spec record; keys are tags, values are `null`
 * (no payload) or {@link payload} markers.
 *
 * @param spec - The variant spec.
 * @returns A {@link MsgBuilder} whose entries are variant constructors.
 *
 * @remarks
 * Adding a tag to `spec` widens `MsgOf<typeof builder>`. Passing that
 * widened union to `createUpdate<MsgOf<...>>` makes the missing
 * handler a compile error at the call site, and a missing arm in a
 * `switch (msg.kind)` is a compile error at {@link assertNever}.
 *
 * @example
 * ```ts
 * const msg = defineMsgs({
 *   inc: null,
 *   dec: null,
 *   set: payload<{ value: number }>(),
 * })
 * type CounterMsg = MsgOf<typeof msg>
 *
 * msg.inc()             // { kind: 'inc' }
 * msg.set({ value: 3 }) // { kind: 'set'; value: 3 }
 * ```
 */
declare function defineMsgs<Spec extends MsgSpec>(spec: Spec): MsgBuilder<Spec>;
/**
 * Exhaustiveness probe for a `switch (msg.kind)`. Place at the
 * `default` arm; the parameter type `never` is satisfied only when
 * every variant has a matching `case`. Adding a tag to the union
 * without a `case` arm is a compile error at this call site.
 *
 * The runtime throw is belt-and-suspenders only — it cannot be
 * reached when the type-check passes.
 *
 * @param value - The post-narrowed message that should be `never`.
 * @throws Error citing the unmatched message variant.
 *
 * @example
 * ```ts
 * function update(msg: CounterMsg, g: Graph): void {
 *   switch (msg.kind) {
 *     case 'inc': return g.commit('inc', tx => ...)
 *     case 'dec': return g.commit('dec', tx => ...)
 *     case 'set': return g.commit('set', tx => tx.set(n, msg.value))
 *     default:    return assertNever(msg)
 *   }
 * }
 * ```
 */
declare function assertNever(value: never): never;

/**
 * Bookkeeping for one entry in the per-provider family registry used
 * by {@link useCauslFamily}. Tracks the node handle returned by
 * the factory and a refcount that tallies live consumers; when the
 * count returns to zero, the hook schedules disposal via
 * `@causl/core/internal`'s `dispose`.
 *
 * @remarks
 * Exported only so {@link CauslContextValue} can carry the typed
 * registry. Treat as internal — adapter authors should not consult
 * the entry directly.
 *
 * @internal
 */
interface FamilyEntry {
    readonly node: Node<unknown>;
    refcount: number;
}
/**
 * Shape of the value travelling through {@link CauslContext}.
 *
 * @typeParam Msg - The application's message union, when an `update`
 * runner has been wired up. Defaults to `unknown` so the context can be
 * created without committing to a specific Msg type at the
 * module-creation site.
 *
 * @remarks
 * `update` is optional: a provider may supply a graph for read-only
 * subscription consumers without also installing a dispatch surface.
 * Hooks that need dispatch (see {@link useDispatch}) throw a
 * descriptive error when `update` is absent.
 */
interface CauslContextValue<Msg = unknown> {
    readonly graph: Graph;
    readonly update?: Update<Msg, Graph> | undefined;
    /**
     * Per-provider registry consumed by {@link useCauslFamily}. Each
     * `<CauslProvider>` mount owns a fresh map so two providers
     * around the same graph keep their own family namespaces; nodes are
     * not shared by accident.
     *
     * @remarks
     * The map is mutable in place — refcount increments and decrements
     * happen during effect cleanup, so the reference itself is stable
     * across renders.
     *
     * @internal
     */
    readonly families: Map<string, FamilyEntry>;
}
/**
 * The single context that carries the engine into the React tree.
 *
 * @remarks
 * A `null` default signals "no Provider above this consumer"; the
 * hooks check for that sentinel and throw a descriptive error. The
 * value is widened to `CauslContextValue<unknown>` at the context
 * boundary so that every consumer can refine `Msg` independently with
 * a generic hook call without forcing a single Msg union onto the
 * context creation site.
 *
 * @see {@link CauslProvider}
 * @see {@link useCausl}
 * @see {@link useDispatch}
 */
declare const CauslContext: react.Context<CauslContextValue<unknown> | null>;

/**
 * @packageDocumentation
 *
 * React provider component for `@causl/react`. `<CauslProvider>`
 * wraps a subtree, accepting a host-constructed {@link Graph} and an
 * optional MVU {@link Update} runner, and routes both through
 * {@link CauslContext}. The provider deliberately does not own the
 * graph — lifecycle, disposal, and replacement remain with the host —
 * so React-side mounting and unmounting cannot cause engine state to
 * be lost between renders. The context value is memoised so
 * referential identity changes only when the inputs do, which keeps
 * `useSyncExternalStore` callers from re-subscribing on every render.
 */

/**
 * Props for {@link CauslProvider}.
 *
 * @typeParam Msg - The application's message union when an `update`
 * runner is supplied; defaults to `unknown` for read-only setups.
 *
 * @remarks
 * The explicit `| undefined` on `update` is required under
 * `exactOptionalPropertyTypes: true` so callers can pass
 * `update={maybeUndefined}` without a TypeScript error.
 */
interface CauslProviderProps<Msg = unknown> {
    readonly graph: Graph;
    /**
     * Optional MVU runner. Note the explicit `| undefined` — required
     * with `exactOptionalPropertyTypes: true` to allow the prop to be
     * passed as `update={maybeUndefined}` cleanly.
     */
    readonly update?: Update<Msg, Graph> | undefined;
    readonly children: ReactNode;
}
/**
 * Provides the engine and an optional MVU runner to its subtree.
 *
 * @typeParam Msg - The application message union accepted by `update`.
 *
 * @param props - The provider props; see {@link CauslProviderProps}.
 * @returns A React element wrapping `children` in {@link CauslContext.Provider}.
 *
 * @remarks
 * The provider does not own the graph — host code constructs and
 * disposes it; the provider only routes the handle. The context value
 * is wrapped in `useMemo` so that consumer hooks do not see a fresh
 * object reference unless `graph` or `update` actually change.
 *
 * @example
 * ```tsx
 * <CauslProvider graph={graph} update={update}>
 *   <App />
 * </CauslProvider>
 * ```
 *
 * @see {@link CauslContext}
 * @see {@link useCausl}
 * @see {@link useDispatch}
 */
declare function CauslProvider<Msg = unknown>(props: CauslProviderProps<Msg>): JSX.Element;

/**
 * @packageDocumentation
 *
 * Primary subscription hook for `@causl/react`. {@link useCausl}
 * binds a selector over the {@link Graph} to React's
 * `useSyncExternalStore`, providing concurrent-render-safe reads with
 * a `GraphTime`-consistent snapshot per render. Re-renders are gated
 * by an `Object.is` comparison at the selector boundary so that
 * commits not affecting the selected slice do not propagate. Selector
 * results are cached against the current graph identity to keep
 * referential stability across re-evaluations triggered by React
 * (strict-mode double invocation, concurrent retries).
 */

/**
 * A pure selector projecting a value from the engine.
 *
 * @typeParam T - The selector's return type.
 *
 * @remarks
 * Selectors must be pure and read only through the supplied `graph`
 * handle. The denotational model treats every value as a
 * `Behavior a := GraphTime → a`, and a derived value at time `t` is a
 * pure function of its inputs at the same time `t`: there is no
 * intermediate "B updated but C did not" state because there is no
 * intermediate time. Reading from anywhere other than the supplied
 * handle (or smuggling state in via closure that doesn't go through
 * the engine) breaks that invariant — two slices read in one render
 * could observe inconsistent `GraphTime`s and the selector would
 * return a glitched value.
 *
 * The handle passed in is a {@link ReadOnlyGraph} — Mark Miller's
 * principle of least authority applied at the React boundary. The
 * selector cannot reach `commit`, `input`, `derived`, or
 * `exportModel`; any attempt throws `CapabilityViolation` from
 * `@causl/core/internal` (the type narrowing forbids it at compile
 * time, the Proxy enforces it at runtime against `as any` coerced
 * leaks). See #229.
 */
type Selector$1<T> = (graph: ReadOnlyGraph) => T;
/**
 * Subscribe to a slice of the graph.
 *
 * @typeParam T - The selector's return type.
 *
 * @param selector - Pure projection from the current `Graph` to the
 * value the component cares about.
 * @returns The currently-selected value; changes between renders only
 * when the selector returns a value not `Object.is`-equal to the
 * previous return.
 * @throws Error when called outside `<CauslProvider>`.
 *
 * @remarks
 * Backed by `useSyncExternalStore` so React 18 concurrent rendering
 * and strict-mode double-invocation behave correctly. The subscription
 * is to the graph's commit log — the engine exposes the transaction
 * log as a `Behavior [Commit]` queryable through the same primitives
 * as any other graph value, and `subscribeCommits` is the narrow
 * notification capability built on top of it. Every commit is a
 * candidate for re-evaluation; the `Object.is` dedup at the selector
 * boundary prevents unrelated commits from causing a render.
 *
 * For selectors returning fresh objects or arrays per call, prefer
 * {@link useCauslShallow} so structurally-equal returns do not
 * defeat the dedup.
 *
 * @example
 * ```tsx
 * const sum = useCausl((g) => g.read(sumNode))
 * ```
 *
 * @see {@link useCauslShallow}
 * @see {@link useDispatch}
 */
declare function useCausl<T>(selector: Selector$1<T>): T;

/**
 * @packageDocumentation
 *
 * Shallow-equal variant of {@link useCausl}. Selectors that
 * compose a fresh object or array per call defeat the `Object.is`
 * dedup the engine relies on — every commit looks like a change
 * because the wrapper reference is new even when the contents have
 * not moved. This module supplies a hook that performs a one-level
 * structural comparison (top-level keys for plain objects, indices
 * for arrays) at the selector boundary, plus the underlying
 * {@link shallowEqual} primitive. Shape inspired by zustand's
 * `useShallow`.
 *
 *   const view = useCausl((g) => ({ a: g.read(a), b: g.read(b) }))
 */

/**
 * A pure selector projecting a value from the engine.
 *
 * @typeParam T - The selector's return type.
 *
 * @remarks
 * The handle is a {@link ReadOnlyGraph} — capability-narrowed at the
 * adapter boundary so the selector cannot reach `commit` / `input` /
 * `derived` / `exportModel`. See #229.
 */
type Selector<T> = (graph: ReadOnlyGraph) => T;
/**
 * Subscribe to a slice of the graph with shallow-equal dedup.
 *
 * @typeParam T - The selector's return type, typically an object or
 * array literal composed inside the selector.
 *
 * @param selector - Pure projection from the current `Graph` to the
 * value the component cares about.
 * @returns The currently-selected value; changes between renders only
 * when {@link shallowEqual} reports a difference against the previous
 * return.
 * @throws Error when called outside `<CauslProvider>`.
 *
 * @remarks
 * Use this in place of {@link useCausl} when the selector returns
 * a freshly-constructed wrapper that would otherwise force a render
 * on every commit. The cache is invalidated if the host swaps the
 * graph handle on the provider.
 *
 * @example
 * ```tsx
 * const { a, b } = useCauslShallow((g) => ({
 *   a: g.read(aNode),
 *   b: g.read(bNode),
 * }))
 * ```
 *
 * @see {@link useCausl}
 * @see {@link shallowEqual}
 */
declare function useCauslShallow<T>(selector: Selector<T>): T;
/**
 * One-level structural equality predicate.
 *
 * @typeParam T - The compared value type.
 *
 * @param a - First value to compare.
 * @param b - Second value to compare.
 * @returns `true` when the values are `Object.is`-equal, or are
 * arrays of equal length whose indices are pairwise `Object.is`-equal,
 * or are plain objects with the same own-key set whose values are
 * pairwise `Object.is`-equal; otherwise `false`.
 *
 * @remarks
 * The predicate is intentionally one level deep — nested objects are
 * compared by reference. That matches the dedup contract: callers who
 * need deeper structural equality should pre-normalise inside the
 * selector or memoise the deeper structures elsewhere.
 *
 * @example
 * ```ts
 * shallowEqual({ a: 1, b: 2 }, { a: 1, b: 2 }) // true
 * shallowEqual([1, 2, 3], [1, 2, 3])           // true
 * shallowEqual({ a: { x: 1 } }, { a: { x: 1 } }) // false (nested ref differs)
 * ```
 */
declare function shallowEqual<T>(a: T, b: T): boolean;

/**
 * @packageDocumentation
 *
 * Per-node subscription hook for `@causl/react`. {@link useCauslNode}
 * binds a single {@link Node} to React via `graph.subscribe(node, cb)`
 * so the component re-renders ONLY when that node's value changes —
 * not on every commit to the graph.
 *
 * This is the per-node subscription path introduced in #677. The
 * selector-based {@link useCausl} hook subscribes to every commit via
 * `subscribeCommits`, then deduplicates at the selector boundary with
 * `Object.is`. `useCauslNode` takes the complementary approach: it
 * subscribes at the engine level to a single node so React's `onChange`
 * never fires for unrelated commits. The engine already applies an
 * `Object.is` equality cutoff before notifying per-node subscribers, so
 * no additional dedup logic is needed here.
 *
 * Performance note: the e2e dropped-frames gate (≤ 5% over 30s on a
 * 1000-cell viewport at 60Hz, plus p95 commit-to-paint ≤ 16ms) shipped
 * in #765 once #738 + #777 hit the underlying ≤ 5.5ms commit bench
 * number from #671. The Playwright spec lives at
 * `packages/react/e2e/tests/dropped-frames-1000.spec.ts`.
 */

/**
 * Subscribe to a single graph node.
 *
 * @typeParam T - Value type of the observed node.
 *
 * @param node - The input or derived node to subscribe to. The component
 * re-renders only when this node's value changes — unrelated commits do
 * not trigger a re-render.
 * @returns The node's current committed value.
 * @throws Error when called outside `<CauslProvider>`.
 *
 * @remarks
 * Backed by `useSyncExternalStore` for concurrent-render safety. The
 * subscription is via `graph.subscribe(node, cb)`, which the engine fires
 * exactly once per commit during which the node's value changed (with the
 * engine's own `Object.is` equality cutoff applied). This is more
 * efficient than the selector-based {@link useCausl} for components that
 * read a single node because React's `onChange` is never invoked for
 * commits that do not touch the subscribed node.
 *
 * For multi-node projections, use {@link useCausl} with a selector.
 *
 * @example
 * ```tsx
 * const total = useCauslNode(totalNode)
 * ```
 *
 * @see {@link useCausl}
 */
declare function useCauslNode<T>(node: Node<T>): T;

/**
 * @packageDocumentation
 *
 * Typed-array projection hook for `@causl/react` (#688, sub-task of
 * #680). {@link useCauslTypedArrayNode} subscribes to a single
 * {@link Node} whose value is bulk numeric data and returns a typed
 * array view (`Float64Array`, `Uint8Array`, `Int32Array`, ...) that
 * is stable across renders until the next commit.
 *
 * @remarks
 * **WASM backend status.** The full zero-copy view-into-linear-memory
 * implementation requires the WASM engine artefacts produced by
 * #682 / #683 / #693; until those land, `loadWasmBackend()` (#1031)
 * throws `WasmBackendUnavailableError`. This hook therefore ships
 * the *fallback* path only:
 *
 *   1. The hook detects the WASM backend by attempting
 *      `loadWasmBackend()` once at module evaluation; the structured
 *      error `code: 'CAUSL_WASM_NOT_BUILT'` flips the hook into
 *      JS-engine mode.
 *   2. In JS-engine mode, it reads the node's current committed value
 *      via `graph.read(node)` and synthesises a typed-array view from
 *      the JS value (zero-copy when the value is already an instance
 *      of the requested constructor; otherwise a `from(...)` copy).
 *   3. View identity is preserved across renders for a given commit:
 *      `useSyncExternalStore.getSnapshot` caches the previous view
 *      and re-returns it when the engine's per-node `Object.is`
 *      cutoff says the value is unchanged.
 *
 * The hook contract is forward-compatible with the WASM path: once
 * the engine ships, callers retain the same call site and start
 * receiving real `WebAssembly.Memory.buffer`-backed views with the
 * same stability guarantee. Until then adopters get a typed-array
 * shape to program against, plus identity stability that lets
 * `React.memo`-style equality skips work today.
 *
 * **`memory.grow()` invariant (deferred — see #680).** The WASM
 * backend must never call `WebAssembly.Memory.grow()` mid-render:
 * grow invalidates every existing view. The engine pre-allocates a
 * worst-case heap and grows only between commit boundaries. The
 * fallback path is unaffected because no shared linear memory is
 * involved — every view is a JS-owned buffer. The invariant becomes
 * load-bearing once #682 / #683 / #693 wire the WASM artifacts; the
 * hook surface here is unchanged.
 *
 * @see {@link https://github.com/iasbuilt/causl/issues/688} — this hook.
 * @see {@link https://github.com/iasbuilt/causl/issues/680} — WASM EPIC.
 * @see {@link https://github.com/iasbuilt/causl/issues/1031} — `loadWasmBackend()` loader stub.
 */

/**
 * The subset of typed-array constructors supported by
 * {@link useCauslTypedArrayNode}. Restricted to the three concrete
 * shapes called out in #688's scope (`Float64Array`, `Uint8Array`,
 * `Int32Array`); other typed arrays can be added without an ABI
 * break by extending this union.
 *
 * @remarks
 * The constraint is on the *constructor instance*, not on a
 * `TypedArray` base class — TypeScript's structural typing does not
 * model `TypedArray` directly, so we enumerate the concrete shapes
 * the hook accepts.
 */
type CauslTypedArray = Float64Array | Uint8Array | Int32Array;
/**
 * Constructor handle for one of {@link CauslTypedArray}. Used by the
 * fallback path's `from(...)` copy to materialise a view of the
 * requested element shape when the node's committed value is not
 * already an instance of `T`.
 */
type CauslTypedArrayCtor<T extends CauslTypedArray> = {
    new (length: number): T;
    from(source: ArrayLike<number>): T;
};
/**
 * Subscribe to a graph node whose value is bulk numeric data,
 * receiving a typed-array view.
 *
 * @typeParam T - One of `Float64Array | Uint8Array | Int32Array`.
 *
 * @param node - The input or derived node to subscribe to. The
 * component re-renders only when this node's value changes — unrelated
 * commits do not trigger a re-render (same per-node-subscription
 * semantics as {@link useCauslNode}).
 * @param ctor - Constructor for the typed array shape to return.
 * Used by the JS-engine fallback to coerce non-`T` committed values
 * (e.g. a plain `number[]`) into a `T` view; ignored on the WASM
 * path where the engine reports the element shape directly.
 * @returns A typed-array view of the node's current committed value.
 * The reference is **stable across renders until the next commit**
 * during which the engine reports a value change — same-commit
 * reads return the identically-`Object.is`-equal view.
 * @throws Error when called outside `<CauslProvider>`.
 *
 * @remarks
 * **Zero-copy path (WASM backend, deferred — #680 / #682 / #683 /
 * #693).** When the WASM backend is active, the returned view points
 * directly into the engine's linear memory: `new ctor(memory.buffer,
 * offset, length)`. No copy occurs per render. The engine guarantees
 * no `memory.grow()` between the `getSnapshot` read and the React
 * render that consumes the view; grows happen only at commit
 * boundaries.
 *
 * **Fallback path (JS engine, today).** The hook reads the node's
 * current value via `graph.read(node)`. If the value is already an
 * instance of `ctor`, it is returned verbatim. Otherwise the hook
 * coerces it via `ctor.from(value)` (one-shot copy on commit). A
 * cached view reference is reused across renders for the same
 * commit, so `React.memo` consumers comparing by identity skip work.
 *
 * **Stability contract.** The view returned for commit `N` is
 * `Object.is`-equal to itself across every render between commit
 * `N` and commit `N+1`. After a commit that changes the subscribed
 * node, the hook returns a *fresh* view (new reference). Adopters
 * MAY rely on `Object.is(viewA, viewB) === false` as a signal that
 * the underlying numeric data changed.
 *
 * @example
 * Subscribe to a `Float64Array` cell range:
 * ```tsx
 * const range = useCauslTypedArrayNode(prices, Float64Array)
 * // `range` is stable across renders until `prices` next changes.
 * ```
 *
 * @example
 * Subscribe to a `Uint8Array` blob in a hex viewer:
 * ```tsx
 * const bytes = useCauslTypedArrayNode(blob, Uint8Array)
 * ```
 *
 * @see {@link useCauslNode} — single-node subscription without typed-array coercion.
 */
declare function useCauslTypedArrayNode<T extends CauslTypedArray>(node: Node<unknown>, ctor: CauslTypedArrayCtor<T>): T;

/**
 * @packageDocumentation
 *
 * Dispatch hook for `@causl/react`. {@link useDispatch} is the
 * read-write companion to {@link useCausl}: it returns a
 * referentially-stable function that forwards application messages
 * into the MVU runner installed on the surrounding
 * `<CauslProvider>`. Each invocation flows through that runner,
 * which is responsible for issuing exactly one `graph.commit(...)`.
 *
 * Commits are the only way time advances. Outside a commit the graph
 * is read-only; inside a commit, reads see staged writes; outside,
 * reads see the previous committed snapshot. Each `commit` produces
 * exactly one new `GraphTime`, which is what triggers the subscription
 * channel that `useCausl` listens on. The runner is the seam where
 * a `Msg` is translated into that single discrete event.
 */
/**
 * Function shape returned by {@link useDispatch}.
 *
 * @typeParam Msg - The application's message union.
 */
type Dispatch<Msg> = (msg: Msg) => void;
/**
 * Hook returning a dispatcher for the application's `Msg` union.
 *
 * @typeParam Msg - The application's message union.
 *
 * @returns A stable dispatcher; identity changes only when the graph
 * handle or the `update` runner identity changes on the surrounding
 * provider.
 * @throws Error when called outside `<CauslProvider>`, or when the
 * provider was not configured with an `update` runner.
 *
 * @remarks
 * The provider must be configured with an `update` function (see
 * {@link CauslProviderProps}). If it is not, calling the dispatcher
 * throws — the throw is deferred to call time so a component can be
 * rendered under a read-only provider without crashing at mount.
 *
 * @example
 * ```tsx
 * const dispatch = useDispatch<Msg>()
 * return <button onClick={() => dispatch({ kind: 'edit-cell', ref, value })}>Save</button>
 * ```
 *
 * @see {@link useCausl}
 * @see {@link Update}
 */
declare function useDispatch<Msg>(): Dispatch<Msg>;

/**
 * @packageDocumentation
 *
 * `useCauslFamily(key, factory)` — parameterised node lifecycle for
 * virtualised rows and other "one node per identity" patterns. Closes
 * Adoption-gap #1 (Jotai's `atomFamily`): a hook that returns a stable
 * `Node<T>` per `key`, identity-shared across consumers within the
 * same `<CauslProvider>`, and disposed when the last consumer
 * unmounts.
 *
 * The first mount of a key invokes the factory; subsequent mounts
 * return the cached node without re-invoking. Disposal is deferred
 * via microtask: when refcount drops to zero, disposal is scheduled
 * for the next microtask rather than running immediately. If a
 * re-mount increments refcount before the microtask fires, disposal
 * is cancelled — that is what makes the hook StrictMode-double-mount
 * safe.
 *
 * The hook returns a `Node<T>`, not a value. Reading the node is a
 * separate `useCausl(graph => graph.read(node))` call, preserving
 * the MVU split between selector-driven subscription and dispatch:
 * the family hook owns identity and lifetime, {@link useCausl}
 * owns the snapshot, and {@link useDispatch} owns mutation.
 *
 * @remarks
 * The registry is per-provider (carried on {@link CauslContext}),
 * not module-global: two `<CauslProvider>` instances in the same
 * tree maintain isolated family namespaces, so a key collision in one
 * provider does not leak a node into the other.
 *
 * Disposal goes through `@causl/core/internal`'s `dispose` rather
 * than a method on the public {@link Graph} interface. The engine's
 * canonical public surface is a small, load-bearing set of primitives
 * the engine cannot exist without; "this node's lifetime is bounded
 * by a component's mount" is an adapter-level concern, not a primitive
 * application code should reach for, so the dispose primitive lives
 * behind the `@causl/core/internal` entrypoint and is not covered
 * by the public package's SemVer guarantees. Routing through the
 * internal entrypoint keeps the public surface honest — a
 * leading-underscore method on `Graph` would still be public — and
 * confines the lifecycle responsibility to the React adapter, which
 * is the only layer that owns the "component mount" concept.
 */

/**
 * Capability handed to a {@link FamilyFactory}. Closes #257 (capability
 * narrowing across factory/selector seams): a factory exists to
 * register one node per key, so it gets `input` + `derived` and
 * nothing else.
 *
 * The narrowing is structural — a real `Graph` is assignable to
 * `FamilyGraph`, but a factory cannot reach back into the engine for
 * `commit`, `read`, `hydrate`, `snapshot`, `exportModel`,
 * `subscribeCommits`, or any other authority outside its registration
 * job. `read` is intentionally excluded: a derived node has its own
 * `get`-tracked accessor inside the compute closure, and a factory
 * that reads outside that closure would observe a snapshot at the
 * wrong time and break dynamic-dependency tracking. SPEC §12.3
 * "smallest interface a consumer needs"; PR #205 introduced the same
 * lens for the test-seam `narrowCapability`. This is the production-
 * code analogue, applied at the type level so the discipline holds at
 * compile time rather than depending on a runtime Proxy.
 */
type FamilyGraph = Pick<Graph, 'input' | 'derived'>;
/**
 * Factory that produces (and registers, via `graph.input` /
 * `graph.derived`) a node for a given `key`.
 *
 * @typeParam T - Value type of the node the factory returns.
 * @param graph - The provider-scoped engine handle, narrowed to the
 *  registration capability ({@link FamilyGraph}). The factory is
 *  expected to call `graph.input(...)` or `graph.derived(...)`
 *  exactly once and return the resulting handle. Methods outside the
 *  narrow surface (`commit`, `hydrate`, `snapshot`, `subscribeCommits`,
 *  …) are intentionally unreachable from here — they are not the
 *  factory's responsibility.
 * @param key - The keying identity passed to the hook.
 * @returns The freshly-registered node handle.
 */
type FamilyFactory<T> = (graph: FamilyGraph, key: string) => Node<T>;
/**
 * Returns a stable `Node<T>` for `key` within the enclosing
 * `<CauslProvider>`. The factory runs once per key per provider;
 * subsequent mounts of the same key return the cached handle. The
 * node is disposed via `@causl/core/internal`'s `dispose` when the
 * last consumer unmounts (deferred to the next microtask so
 * StrictMode's double-invoke does not destroy and recreate the node).
 *
 * @typeParam T - Value type of the node the factory produces.
 * @param key - Keying identity. Identity is per-(provider, key); two
 *  providers around the same graph maintain isolated namespaces.
 * @param factory - Producer that constructs and registers the node
 *  the first time `key` is seen in this provider.
 * @returns The cached or freshly-registered node handle for `key`.
 *
 * @throws Error when called outside a `<CauslProvider>`.
 *
 * @example
 * ```tsx
 * const node = useCauslFamily(`row:${rowId}`, (graph, key) =>
 *   graph.input(key, defaultRow),
 * )
 * const value = useCausl((g) => g.read(node))
 * ```
 *
 * @see {@link FamilyFactory}
 * @see {@link CauslContext}
 */
declare function useCauslFamily<T>(key: string, factory: FamilyFactory<T>): Node<T>;

/**
 * useCauslSuspense — Suspense projection of Resource-shaped values.
 *
 * Closes #127. Closes Adoption-gap #2 (Jotai's Suspense atoms): the
 * tagged-union `ResourceState<T>` from `@causl/sync` becomes a
 * value `T` that integrates with `<Suspense>` and React error
 * boundaries.
 *
 * Mapping:
 *   - `loading` → throw the in-flight Promise carried on the state
 *                 (engine-anchored, identity-stable across renders for
 *                 the same loading episode — SPEC §9.1).
 *   - `loaded`  → return `value`.
 *   - `stale`   → return cached `value` (do not throw — we already
 *                 have a value to render; the application can refetch
 *                 explicitly).
 *   - `errored` → throw `error` (Error Boundary catches it).
 *   - `idle`    → throw a Promise that resolves on the next graph
 *                 commit. Identity-stable per graph; the application
 *                 must trigger a fetch for the resource to leave
 *                 `idle`. The contract is "suspend, not error".
 *
 * The selector returns the canonical `ResourceState<T>` from
 * `@causl/sync` — no fork. `SuspendableResource<T>` is kept as a
 * type alias for backward compatibility with consumers that imported
 * it from this package.
 */

/**
 * Backward-compatible alias for the canonical `ResourceState<T>` from
 * `@causl/sync`. The previous shape was a structurally-incompatible
 * fork that invented `promise?` on `loading` and dropped `origin:
 * GraphTime` / `loadedAt` / `erroredAt`; consumers that only checked
 * the tag continue to type-check, while the engine-anchored fields
 * (`origin`, `loadedAt`, `erroredAt`, `promise`) are now visible to
 * them.
 */
type SuspendableResource<T> = ResourceState<T>;
/**
 * Project a `ResourceState<T>` through a selector and return `T` —
 * throwing for Suspense or an error boundary as appropriate.
 *
 * The selector receives a {@link ReadOnlyGraph} (capability-narrowed
 * via `narrowCapability` at the `useCausl` boundary) — Mark
 * Miller's principle of least authority. A selector cannot reach
 * `commit` / `input` / `derived` / `exportModel`; the type narrowing
 * is the compile-time gate, the runtime Proxy throws
 * `CapabilityViolation` against `as any`-coerced leaks. See #229.
 */
declare function useCauslSuspense<T>(selector: (graph: ReadOnlyGraph) => SuspendableResource<T>): T;

/**
 * <Hydrate snapshot={…}> — applies a server-captured GraphSnapshot to
 * the engine before children commit (#130, #219).
 *
 * Usage (Next.js App Router):
 *
 *   // app/page.tsx (server component)
 *   const graph = createCausl()
 *   bootGraphFromDb(graph)
 *   const snapshot = graph.snapshot()
 *   return (
 *     <CauslProvider graph={clientGraph}>
 *       <Hydrate snapshot={snapshot}>
 *         <App />
 *       </Hydrate>
 *     </CauslProvider>
 *   )
 *
 * Channel choice — `useLayoutEffect`, not render-phase mutation. Render
 * bodies must be pure: a discarded `Suspense` / `startTransition`
 * render must not leave the engine hydrated for a commit that never
 * happened. `useLayoutEffect` runs synchronously after render but
 * before paint, so SSR HTML and the first client paint still observe
 * the same hydrated values, while render itself stays pure.
 *
 * Keying — `[ctx.graph]`. The guard is per (component-instance ×
 * graph-identity), not per-component-instance. Swapping the provider
 * graph re-arms hydration on the new graph; snapshot-prop churn
 * without a graph swap is a no-op (the engine's `hydrate` is
 * non-monotonic on `now`, so re-hydrating on every prop change would
 * drag GraphTime backward). The module-scoped `WeakMap` keyed by
 * `Graph` subsumes the per-instance `useRef<Graph|null>` keying
 * tried in #324: graph-identity is the contract boundary, so we
 * key off of it directly rather than off a component-instance ref
 * that doesn't survive StrictMode's mount/cleanup/remount cycle.
 *
 * StrictMode safety — under React 18 StrictMode, the layout effect
 * runs on mount, the cleanup runs, and the effect runs again on the
 * remount with a fresh component instance (refs reset). A
 * module-scoped `WeakMap<Graph, GraphSnapshot>` registry of pairs
 * already applied survives the cycle: the second remount finds the
 * pair recorded and short-circuits. Subscribers see exactly one
 * `Commit { intent: 'hydrate' }` per provider mount.
 */

interface HydrateProps {
    readonly snapshot: GraphSnapshot;
    readonly children: ReactNode;
}
declare function Hydrate({ snapshot, children }: HydrateProps): JSX.Element;

/**
 * @packageDocumentation
 *
 * Public entry point for `@causl/react`, the React binding layer for
 * the Causl dependency engine. This module re-exports the provider,
 * hooks, MVU update helpers, and supporting types that together form
 * the application surface for React hosts.
 *
 * The barrel is deliberately narrow. `tx.set(node, value)` is a *write
 * API*, not a *thinking API*: application developers do not think "I
 * will mutate `cell:wb1:Sheet1:A1`," they think "the user clicked
 * Save." The MVU shape — typed `Msg` discriminated unions plus an
 * `update` runner — is the front door that lets `Msg` carry the "make
 * impossible states impossible" guarantee at the application surface
 * rather than scattering it across 57 internal enum tags. The previous
 * draft's nine kinds of hook (`useGraphValue`, `useGraphStatus`,
 * `useGraphConflicts`, `useGraphExplanation`, `useGraphTransaction`,
 * `useGraphDerived`, `useGraphSelector`, `useGraphResource`) collapse
 * to two: {@link useCausl} for selector-driven subscription and
 * {@link useDispatch} for typed dispatch. Status, conflicts, and
 * explanations are values selectable from the same store and do not
 * need their own hooks.
 *
 * Public surface:
 *   - CauslProvider          — provides a Graph through React context
 *   - useCausl(selector)     — re-renders when the selected value changes
 *   - useDispatch()             — returns a typed Msg dispatcher
 *   - createUpdate<Msg, Graph>  — typed Update<Msg, Graph> runner factory
 *   - defineMsgs / MsgOf / Msg  — typed Msg discriminated-union helper (#369)
 *   - assertNever               — exhaustiveness probe for switch (msg.kind)
 */
/** MVU runner type and helpers for sequencing app messages into commits. */

/**
 * Package version literal. Pinned to `'0.0.0'` until the binding ships
 * a tagged release; consumers can use it as a runtime version probe.
 */
declare const VERSION = "0.0.0";

export { CauslContext, type CauslContextValue, CauslProvider, type CauslProviderProps, type CauslTypedArray, type CauslTypedArrayCtor, type Dispatch, type FamilyFactory, type FamilyGraph, Hydrate, type HydrateProps, type Msg, type MsgBuilder, type MsgOf, type MsgSpec, type PayloadMarker, type Selector$1 as Selector, type SuspendableResource, type Update, VERSION, assertNever, createUpdate, defineMsgs, payload, runMessages, shallowEqual, useCausl, useCauslFamily, useCauslNode, useCauslShallow, useCauslSuspense, useCauslTypedArrayNode, useDispatch };
