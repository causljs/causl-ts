/**
 * @causl/devtools-bridge — `connectDevtools`.
 *
 * Wires a {@link Graph} to the Redux DevTools Extension over the
 * extension's monitor protocol. When the extension is absent the
 * function is a zero-cost no-op: it short-circuits before allocating
 * any subscription, mock, or observer (asserted by
 * `connectDevtools.zero-cost.test.ts`).
 *
 * Each {@link Commit} forwarded to the panel becomes a Redux action of
 * the form `{ type: intent, payload: { changedNodes } }` paired with a
 * `graph.snapshot()` for state inspection.
 *
 * The reverse path implements the ten monitor messages the extension
 * sends back. Each message is handled by a dedicated, individually
 * tested closure attached to a frozen handler table:
 *
 *   - `JUMP_TO_STATE` / `JUMP_TO_ACTION` — drive time travel.
 *   - `PAUSE_RECORDING`                  — stop forwarding commits.
 *   - `LOCK_CHANGES`                     — drop incoming protocol messages.
 *   - `IMPORT_STATE`                     — bulk-load a captured state.
 *   - `COMMIT`                           — accept the current state as baseline.
 *   - `ROLLBACK`                         — restore the last accepted baseline.
 *   - `SWEEP`                            — clear the skipped-action set.
 *   - `TOGGLE_ACTION`                    — mark a specific action as skipped.
 *   - `TOGGLE_PERSIST`                   — toggle the persistence flag the panel
 *                                          surfaces; advisory.
 *
 * Time-travel handlers (JUMP / IMPORT_STATE / ROLLBACK) project state
 * via `graph.snapshotAt(t)` — a *read*, not a mutation (#213). The
 * engine's denotational meaning is `derived(t) = f(b₁(t), ..., bₙ(t))`:
 * a derived value at time `t` is a pure function of its inputs at the
 * same `t`, and the only way GraphTime advances is one new commit per
 * `graph.commit`. A panel-driven mutation would forge a fractional or
 * out-of-order time, so the bridge stays read-only — the engine is
 * never hydrated by panel input; the panel receives a re-init carrying
 * the historical projection, and the host's live subscribers stay
 * anchored at the present.
 *
 * ## §17.4 — discriminated unions are tagged unions (#379)
 *
 * The wire-shape `DevtoolsMessage` used to hoist `state?: string` to
 * the union root and rely on optional-presence to encode "is this a
 * JUMP variant or not". Likewise `PauseRecording.status?: boolean` and
 * `LockChanges.status?: boolean` encoded a toggle-vs-set state machine
 * as the presence/absence of a field. Both patterns leak into runtime
 * casts — the §17.4 anti-pattern.
 *
 * The shape was reworked in #379: the protocol-seam decode (the
 * `subscribe` callback) normalises the wire into a strongly-typed
 * {@link DispatchEvent} that carries the variant's discriminator at
 * the top level — `JUMP_TO_STATE` requires `state: string`;
 * toggle-vs-set is encoded as separate `_TOGGLE` / `_SET` events.
 * Handler closures receive the narrowed payload directly; no
 * `(msg as ...)` casts survive past the decode boundary.
 */

import type { Graph, GraphSnapshot, GraphTime, Unsubscribe } from '@causl/core'

/**
 * Capability slice handed to {@link connectDevtools}.
 *
 * Closes #364: the bridge is a *view*, not an editor — the doc-block
 * above (and `applyJumpHandler`'s comment) argue at length that time
 * travel must be a *read* through `snapshotAt`, never a mutation
 * through `commit`, because a panel-driven mutation would forge a
 * fractional or out-of-order time. The full `Graph` parameter that
 * #257 left in place contradicted that comment: it let a future bridge
 * edit silently call `graph.commit(...)`, `graph.input(...)`,
 * `graph.hydrate(...)`, or `graph.derived(...)` and reduced the
 * discipline to a code-review hope. Per §12.3 the parameter exposes
 * exactly the four methods the bridge actually calls:
 * `subscribeCommits` (forward each commit as an action), `snapshot`
 * (initial state and per-commit state hand-off to the panel),
 * `snapshotAt` (time-travel projection), and `now` (baseline-time
 * stamp).
 *
 * Narrowing is type-level. A real `Graph` is still assignable, so the
 * call site keeps working; the discipline is enforced at compile time
 * inside the implementation. The Proxy-based runtime gate
 * `narrowCapability` from `@causl/core/internal` is *not* applied
 * here because it deliberately omits `snapshot` / `snapshotAt` (its
 * allow-list is `read` / `subscribe` / `subscribeCommits` / `now` —
 * the read-only slice for application code), and the bridge's
 * authority profile is bridge-specific (it must hand the panel a
 * `GraphSnapshot`, which `narrowCapability` does not expose).
 */
export type BridgeGraph = Pick<Graph, 'subscribeCommits' | 'snapshot' | 'snapshotAt' | 'now'>

/**
 * Subset of the Redux DevTools Extension surface we actually call.
 *
 * @remarks
 * Typed as a structural interface rather than a hard import so the
 * package stays free of `redux-devtools-extension` at runtime — the
 * extension is browser-injected, not an npm dependency.
 */
interface ReduxDevtoolsExtension {
  connect(options?: { name?: string }): ReduxDevtoolsConnection
}

interface ReduxDevtoolsConnection {
  init(initialState: unknown): void
  send(action: { type: string; payload?: unknown }, state: unknown): void
  subscribe(listener: (message: ReduxMessage) => void): () => void
  unsubscribe(): void
}

/**
 * Wire-level discriminated union over the messages the extension may
 * emit. This is the *raw* shape we receive from the panel — the
 * protocol-seam decode normalises it into {@link DispatchEvent} before
 * routing.
 *
 * @remarks
 * Three of the ten DISPATCH variants — `JUMP_TO_STATE`,
 * `JUMP_TO_ACTION`, and `IMPORT_STATE` — receive a serialised snapshot
 * via the top-level `state?: string`. The wire-shape declares it
 * optional because the panel sometimes omits it on malformed dispatch;
 * the protocol-seam decode is what enforces presence and produces the
 * narrowed handler input. See {@link DispatchEvent} for the post-decode
 * shape.
 */
export type DevtoolsMessage =
  | { readonly type: 'DISPATCH'; readonly payload: WirePayload; readonly state?: string }
  | { readonly type: 'ACTION' | 'START' | 'STOP'; readonly payload?: unknown; readonly state?: string }

/**
 * Wire-level payload union — what the panel sends inside a DISPATCH
 * envelope. Optional fields here reflect the *protocol's* tolerance
 * (the panel sometimes omits `status` to mean "toggle"), not the
 * type-system contract for handler inputs.
 */
type WirePayload =
  | JumpToStateWirePayload
  | JumpToActionWirePayload
  | PauseRecordingWirePayload
  | LockChangesWirePayload
  | ImportStateWirePayload
  | CommitWirePayload
  | RollbackWirePayload
  | SweepWirePayload
  | ToggleActionWirePayload
  | TogglePersistWirePayload

interface JumpToStateWirePayload {
  readonly type: 'JUMP_TO_STATE'
  readonly index?: number
}
interface JumpToActionWirePayload {
  readonly type: 'JUMP_TO_ACTION'
  readonly actionId?: number
}
interface PauseRecordingWirePayload {
  readonly type: 'PAUSE_RECORDING'
  readonly status?: boolean
}
interface LockChangesWirePayload {
  readonly type: 'LOCK_CHANGES'
  readonly status?: boolean
}
interface ImportStateWirePayload {
  readonly type: 'IMPORT_STATE'
  readonly nextLiftedState?: { computedStates?: Array<{ state: unknown }> }
}
interface CommitWirePayload {
  readonly type: 'COMMIT'
}
interface RollbackWirePayload {
  readonly type: 'ROLLBACK'
}
interface SweepWirePayload {
  readonly type: 'SWEEP'
}
interface ToggleActionWirePayload {
  readonly type: 'TOGGLE_ACTION'
  readonly id: number
}
interface TogglePersistWirePayload {
  readonly type: 'TOGGLE_PERSIST'
}

/**
 * Post-decode dispatch event — what handlers actually receive.
 *
 * @remarks
 * Each variant's `kind` is the discriminator for the handler table.
 * `state: string` is required on the three time-travel variants (the
 * §17.4 narrowing fix from #379); the toggle-vs-set ambiguity on
 * PAUSE_RECORDING / LOCK_CHANGES is split into `_TOGGLE` / `_SET`
 * variants so the operation is encoded in the discriminator, not in
 * the absence of a field. IMPORT_STATE carries a guaranteed-non-empty
 * `times: ReadonlyArray<number>` so the handler does no further
 * narrowing.
 */
export type DispatchEvent =
  | { readonly kind: 'JUMP_TO_STATE'; readonly state: string }
  | { readonly kind: 'JUMP_TO_ACTION'; readonly state: string }
  | { readonly kind: 'PAUSE_RECORDING_TOGGLE' }
  | { readonly kind: 'PAUSE_RECORDING_SET'; readonly status: boolean }
  | { readonly kind: 'LOCK_CHANGES_TOGGLE' }
  | { readonly kind: 'LOCK_CHANGES_SET'; readonly status: boolean }
  | { readonly kind: 'IMPORT_STATE'; readonly times: ReadonlyArray<number> }
  | { readonly kind: 'COMMIT' }
  | { readonly kind: 'ROLLBACK' }
  | { readonly kind: 'SWEEP' }
  | { readonly kind: 'TOGGLE_ACTION'; readonly id: number }
  | { readonly kind: 'TOGGLE_PERSIST' }

/**
 * A loose alias used at the protocol seam where `subscribe(listener)`
 * passes us whatever the extension thinks is well-typed. We narrow on
 * `payload.type` per dispatch.
 */
type ReduxMessage = DevtoolsMessage

export interface ConnectOptions {
  /** Display name in the Redux DevTools panel. Defaults to `"causl"`. */
  readonly name?: string
}

declare global {

  var __REDUX_DEVTOOLS_EXTENSION__: ReduxDevtoolsExtension | undefined
}

/**
 * Cheap predicate used by `connectDevtools` and by tree-shake assertions
 * in the test suite. Pure read of `globalThis`; no side effects, no
 * allocations.
 */
export function isExtensionAvailable(): boolean {
  return typeof globalThis.__REDUX_DEVTOOLS_EXTENSION__ !== 'undefined'
}

/**
 * Per-message handler context handed to every entry in the handler
 * table. Keeps the protocol logic pure and unit-testable in isolation.
 */
interface HandlerContext {
  readonly graph: BridgeGraph
  readonly conn: ReduxDevtoolsConnection
  /** Mutable bridge state — toggled by recording / lock / persist messages. */
  readonly state: BridgeState
  /** Latest known committed baseline snapshot (the panel's "reset" point). */
  baseline: GraphSnapshot
  /**
   * GraphTime corresponding to {@link baseline}. ROLLBACK projects state
   * at this time via `graph.snapshotAt(t)` so the panel re-displays the
   * baseline without mutating the live engine — time advances only via
   * `graph.commit`, never via the panel (#213).
   */
  baselineTime: GraphTime
}

/**
 * Mutable, encapsulated state owned by a single `connectDevtools` call.
 *
 * @remarks
 * Exposed as a plain object so individual handlers can mutate it via
 * the {@link HandlerContext}. Disposal drops every reference.
 */
export interface BridgeState {
  /** When `true`, commits are not forwarded to the panel. */
  paused: boolean
  /** When `true`, incoming monitor messages are dropped before dispatch. */
  locked: boolean
  /** Advisory persistence flag toggled by `TOGGLE_PERSIST`. */
  persist: boolean
  /** GraphTime values the panel has marked as skipped via `TOGGLE_ACTION`. */
  readonly skipped: Set<number>
}

/**
 * Apply a JUMP-style time-travel transition.
 *
 * @remarks
 * Time travel is a *view*, not an *edit* (#213). The engine's
 * denotational rule is that a transaction creates exactly one new `t`,
 * with no fractional time and no concurrent-mutation API; outside a
 * commit the graph is read-only. So the panel supplies the state it
 * wants to revisit; the bridge extracts the GraphTime, projects state
 * via `graph.snapshotAt(t)`, and re-inits the panel with that
 * projection. The live engine is never hydrated, so host subscribers
 * stay anchored at the present.
 *
 * Failure modes — all silent: out-of-window time (`evicted`),
 * unparseable `state` payload, or missing time field. The panel's bug
 * isn't ours.
 */
function applyJumpHandler(ctx: HandlerContext, state: string): void {
  let snap: { time?: unknown }
  try {
    snap = JSON.parse(state) as { time?: unknown }
  } catch {
    return
  }
  if (typeof snap.time !== 'number') return
  const result = ctx.graph.snapshotAt(snap.time)
  if (result.status !== 'retained') return
  ctx.conn.init(result.value)
}

/**
 * Discriminator string for the messages we route. Re-derived from
 * {@link DispatchEvent} via TypeScript's `kind` narrowing so adding a
 * new variant forces a corresponding handler entry.
 */
export type MonitorMessageKind = DispatchEvent['kind']

/**
 * Map each `DispatchEvent['kind']` to its narrowed event type, so the
 * handler table can declare per-variant input types without `any` or
 * casts. `Extract<DispatchEvent, { kind: K }>` is the §17.4-shaped
 * narrowing — adding a new variant to {@link DispatchEvent} forces a
 * matching handler signature at compile time.
 */
type EventOf<K extends MonitorMessageKind> = Extract<DispatchEvent, { readonly kind: K }>
type Handlers = {
  readonly [K in MonitorMessageKind]: (event: EventOf<K>) => void
}

/**
 * Build the handler table. One closure per monitor-message kind; each
 * closes over the shared {@link HandlerContext} so individual messages
 * can mutate bridge state independently.
 *
 * @remarks
 * Returning a frozen record makes the dispatch path branchless once
 * V8 inlines `handlers[event.kind]`, and lets tests import the table
 * directly to assert per-handler behaviour without round-tripping
 * through the extension mock. Per-variant input types are pinned via
 * the `EventOf<K>` mapped type so a future maintainer cannot widen a
 * handler's parameter to `unknown` without breaking compile.
 */
function buildHandlers(ctx: HandlerContext): Handlers {
  const table: Handlers = {
    /** JUMP_TO_STATE — see {@link applyJumpHandler}. */
    JUMP_TO_STATE: (event) => applyJumpHandler(ctx, event.state),

    /**
     * JUMP_TO_ACTION — same projection as JUMP_TO_STATE; the extension
     * uses two ids (action id vs computed-state index) but the wire
     * payload is interchangeable.
     */
    JUMP_TO_ACTION: (event) => applyJumpHandler(ctx, event.state),

    /**
     * PAUSE_RECORDING_TOGGLE — flip the bridge's recording flag. The
     * toggle-vs-set ambiguity that the panel encodes via
     * `status?: boolean` was lifted into the discriminator at the
     * protocol seam (#379) so the handler is unambiguous.
     */
    PAUSE_RECORDING_TOGGLE: () => {
      ctx.state.paused = !ctx.state.paused
    },
    /** PAUSE_RECORDING_SET — explicitly set the recording flag. */
    PAUSE_RECORDING_SET: (event) => {
      ctx.state.paused = event.status
    },

    /**
     * LOCK_CHANGES_TOGGLE — flip the lock flag. The bridge protects the
     * engine from further panel-driven dispatches when locked; the
     * dispatcher checks `state.locked` per call so toggling is
     * synchronous.
     */
    LOCK_CHANGES_TOGGLE: () => {
      ctx.state.locked = !ctx.state.locked
    },
    /** LOCK_CHANGES_SET — explicitly set the lock flag. */
    LOCK_CHANGES_SET: (event) => {
      ctx.state.locked = event.status
    },

    /**
     * IMPORT_STATE — bulk-load a previously captured `nextLiftedState`.
     * The protocol-seam decode produces a guaranteed-non-empty
     * `times: ReadonlyArray<number>`; we project the last one via
     * `snapshotAt` (a *read*, not a mutation; the engine's only
     * mutation entry is `graph.commit` advancing time by one — #213)
     * and re-init the panel with that projection.
     *
     * The bridge does not adopt the imported state as the live engine
     * state; the host's subscribers stay anchored at the present. The
     * baseline is *not* shifted here — `COMMIT` is the explicit
     * baseline-promotion message and IMPORT_STATE leaves it alone.
     */
    IMPORT_STATE: (event) => {
      const lastTime = event.times[event.times.length - 1]
      if (lastTime === undefined) return
      const result = ctx.graph.snapshotAt(lastTime)
      if (result.status !== 'retained') return
      ctx.conn.init(result.value)
    },

    /**
     * COMMIT — promote the current state to the new baseline so that a
     * later `ROLLBACK` projects here. The extension also expects the
     * action log to be cleared; we re-init the panel with the new base.
     */
    COMMIT: () => {
      ctx.baseline = ctx.graph.snapshot()
      ctx.baselineTime = ctx.graph.now
      ctx.conn.init(ctx.baseline)
    },

    /**
     * ROLLBACK — project the panel back to the baseline GraphTime via
     * `graph.snapshotAt`. The live engine is never hydrated; host
     * subscribers stay anchored at the present, because time advances
     * only by one new `t` per `graph.commit` and the panel never owns
     * that operation (#213).
     */
    ROLLBACK: () => {
      const result = ctx.graph.snapshotAt(ctx.baselineTime)
      if (result.status !== 'retained') return
      ctx.conn.init(result.value)
    },

    /**
     * SWEEP — the panel asks us to clear the skipped-action set.
     * Skipped tracking is bookkeeping only (no engine effect today); we
     * still honour the message so the UI's "sweep" affordance is real.
     */
    SWEEP: () => {
      ctx.state.skipped.clear()
    },

    /**
     * TOGGLE_ACTION — flip the skipped flag for a single action id.
     * Today's implementation is bookkeeping-only; once we wire skipped
     * actions through the recompute path this becomes a re-projection.
     */
    TOGGLE_ACTION: (event) => {
      if (ctx.state.skipped.has(event.id)) ctx.state.skipped.delete(event.id)
      else ctx.state.skipped.add(event.id)
    },

    /**
     * TOGGLE_PERSIST — flip the advisory persistence flag the panel
     * surfaces. The bridge does not own persistence; downstream
     * adapters (e.g. `@causl/persistence`) read `ctx.state.persist`.
     */
    TOGGLE_PERSIST: () => {
      ctx.state.persist = !ctx.state.persist
    },
  }
  return Object.freeze(table)
}

/**
 * Protocol-seam decoder. The single point in the bridge that converts
 * an untrusted wire message into a typed {@link DispatchEvent}. Returns
 * `null` for non-DISPATCH envelopes, malformed payloads, or unknown
 * payload kinds — the dispatcher drops those silently because the
 * monitor protocol is forward-compatible by design.
 *
 * @remarks
 * This is the §17.4 narrowing boundary (#379). All `as` casts in the
 * production path live here and only here; downstream handlers receive
 * a fully typed `DispatchEvent` and never look at the wire shape
 * again.
 */
export function decodeDispatch(msg: ReduxMessage): DispatchEvent | null {
  if (msg.type !== 'DISPATCH' || !msg.payload) return null
  const payload = msg.payload as { type?: unknown }
  if (typeof payload.type !== 'string') return null
  switch (payload.type) {
    case 'JUMP_TO_STATE': {
      const state = (msg as { state?: unknown }).state
      if (typeof state !== 'string') return null
      return { kind: 'JUMP_TO_STATE', state }
    }
    case 'JUMP_TO_ACTION': {
      const state = (msg as { state?: unknown }).state
      if (typeof state !== 'string') return null
      return { kind: 'JUMP_TO_ACTION', state }
    }
    case 'PAUSE_RECORDING': {
      const status = (payload as { status?: unknown }).status
      if (typeof status === 'boolean') return { kind: 'PAUSE_RECORDING_SET', status }
      return { kind: 'PAUSE_RECORDING_TOGGLE' }
    }
    case 'LOCK_CHANGES': {
      const status = (payload as { status?: unknown }).status
      if (typeof status === 'boolean') return { kind: 'LOCK_CHANGES_SET', status }
      return { kind: 'LOCK_CHANGES_TOGGLE' }
    }
    case 'IMPORT_STATE': {
      const next = (payload as { nextLiftedState?: { computedStates?: unknown } })
        .nextLiftedState
      const computed = next?.computedStates
      if (!Array.isArray(computed) || computed.length === 0) return null
      const times: number[] = []
      for (const entry of computed as ReadonlyArray<{ state?: unknown }>) {
        const state = entry?.state as { time?: unknown } | undefined
        if (!state || typeof state !== 'object' || typeof state.time !== 'number') continue
        times.push(state.time)
      }
      if (times.length === 0) return null
      return { kind: 'IMPORT_STATE', times }
    }
    case 'COMMIT':
      return { kind: 'COMMIT' }
    case 'ROLLBACK':
      return { kind: 'ROLLBACK' }
    case 'SWEEP':
      return { kind: 'SWEEP' }
    case 'TOGGLE_ACTION': {
      const id = (payload as { id?: unknown }).id
      if (typeof id !== 'number') return null
      return { kind: 'TOGGLE_ACTION', id }
    }
    case 'TOGGLE_PERSIST':
      return { kind: 'TOGGLE_PERSIST' }
    default:
      // Forward-compat: unknown DISPATCH kinds are silently dropped.
      return null
  }
}

/**
 * Per-graph connection record. A single React 18/19 StrictMode
 * mount/unmount/mount cycle (or two simultaneous calls in the same
 * effect frame) is forced to share one underlying connection via
 * refcounting (#238). When `refcount` drops to zero the actual
 * `conn.unsubscribe()` runs and the entry is removed from the
 * registry.
 */
interface SharedConnection {
  refcount: number
  cleanup: () => void
}

/**
 * Per-graph live-connection registry. Weak-keyed so disposed graphs
 * don't pin entries; refcounted so concurrent `connectDevtools(g)`
 * calls share a single panel connection (#238).
 */
const ACTIVE = new WeakMap<BridgeGraph, SharedConnection>

/**
 * Wire a {@link Graph} to the Redux DevTools Extension and return a
 * disposer.
 *
 * @param graph - The engine to bridge.
 * @param options - Caller tuning; only `name` is supported today.
 * @returns A disposer that decrements the per-graph refcount and runs
 *   the actual cleanup on the last release. Idempotent — calling the
 *   disposer twice is a no-op (#238).
 *
 * @remarks
 * When `__REDUX_DEVTOOLS_EXTENSION__` is undefined this returns an
 * inert shared no-op without allocating the connection, the handler
 * table, or the bridge state. The zero-cost gate test asserts no
 * observable side-effects in that path.
 *
 * Under React StrictMode the host calls `connectDevtools(g)` twice
 * in the same effect cycle (mount → cleanup → mount) and may also
 * have two live mounts overlapping for the same graph instance.
 * Both cases share a single underlying panel connection via
 * `ACTIVE` (#238).
 */
export function connectDevtools(graph: BridgeGraph, options: ConnectOptions = {}): Unsubscribe {
  const ext = globalThis.__REDUX_DEVTOOLS_EXTENSION__
  if (!ext) {
    // Zero-cost no-op path. No allocations beyond the closure itself.
    return noop
  }

  // If a live connection already exists for this graph, take a
  // refcount ticket and return an idempotent decrementer.
  const existing = ACTIVE.get(graph)
  if (existing) {
    existing.refcount += 1
    return makeDisposer(graph)
  }

  const conn = ext.connect({ name: options.name ?? 'causl' })

  // Initial state — also serves as the first ROLLBACK baseline.
  const initial = graph.snapshot()
  conn.init(initial)

  const state: BridgeState = {
    paused: false,
    locked: false,
    persist: false,
    skipped: new Set<number>(),
  }
  const ctx: HandlerContext = {
    graph,
    conn,
    state,
    baseline: initial,
    baselineTime: graph.now,
  }
  const handlers = buildHandlers(ctx)

  const unsubCommits = graph.subscribeCommits((c) => {
    if (state.paused) return
    conn.send(
      { type: c.intent, payload: { changedNodes: Array.from(c.changedNodes) } },
      graph.snapshot(),
    )
  })

  const unsubExt = conn.subscribe((msg) => {
    const event = decodeDispatch(msg)
    if (event === null) return
    // Drop everything (except LOCK_CHANGES_* itself) once the panel
    // locks changes — this is the protocol contract for that message.
    if (
      state.locked &&
      event.kind !== 'LOCK_CHANGES_TOGGLE' &&
      event.kind !== 'LOCK_CHANGES_SET'
    ) {
      return
    }
    dispatch(handlers, event)
  })

  ACTIVE.set(graph, {
    refcount: 1,
    cleanup: () => {
      unsubCommits()
      unsubExt()
      conn.unsubscribe()
    },
  })

  return makeDisposer(graph)
}

/**
 * Route a typed {@link DispatchEvent} to its handler. The switch is
 * exhaustive over `event.kind`; the eslint rule from #291
 * (`@typescript-eslint/switch-exhaustiveness-check` with
 * `considerDefaultExhaustiveForUnions`) makes adding a new variant
 * without a matching `case` a compile-time error.
 */
function dispatch(handlers: Handlers, event: DispatchEvent): void {
  switch (event.kind) {
    case 'JUMP_TO_STATE':
      handlers.JUMP_TO_STATE(event)
      return
    case 'JUMP_TO_ACTION':
      handlers.JUMP_TO_ACTION(event)
      return
    case 'PAUSE_RECORDING_TOGGLE':
      handlers.PAUSE_RECORDING_TOGGLE(event)
      return
    case 'PAUSE_RECORDING_SET':
      handlers.PAUSE_RECORDING_SET(event)
      return
    case 'LOCK_CHANGES_TOGGLE':
      handlers.LOCK_CHANGES_TOGGLE(event)
      return
    case 'LOCK_CHANGES_SET':
      handlers.LOCK_CHANGES_SET(event)
      return
    case 'IMPORT_STATE':
      handlers.IMPORT_STATE(event)
      return
    case 'COMMIT':
      handlers.COMMIT(event)
      return
    case 'ROLLBACK':
      handlers.ROLLBACK(event)
      return
    case 'SWEEP':
      handlers.SWEEP(event)
      return
    case 'TOGGLE_ACTION':
      handlers.TOGGLE_ACTION(event)
      return
    case 'TOGGLE_PERSIST':
      handlers.TOGGLE_PERSIST(event)
      return
  }
}

/**
 * Build the per-call disposer. Captures whether *this* disposer has
 * already run so subsequent invocations are no-ops; on the first run
 * it decrements the per-graph refcount and triggers cleanup at zero.
 */
function makeDisposer(graph: BridgeGraph): Unsubscribe {
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    const entry = ACTIVE.get(graph)
    if (!entry) return
    entry.refcount -= 1
    if (entry.refcount <= 0) {
      ACTIVE.delete(graph)
      entry.cleanup()
    }
  }
}

/**
 * Module-level shared no-op disposer used by the absent-extension path.
 *
 * @remarks
 * Hoisting this avoids allocating a fresh closure per `connectDevtools`
 * call and lets the zero-cost gate test compare against a stable
 * reference identity.
 */
function noop(): void {
  /* intentional no-op */
}

/**
 * Internal-only export used by the test suite to verify handler
 * coverage without round-tripping through the extension mock. Not part
 * of the public package surface — `index.ts` does not re-export it.
 */
export const _internalForTests = {
  buildHandlers,
  decodeDispatch,
  noop,
}
