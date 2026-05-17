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

import type { Graph } from '@causljs/core'

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
export type Update<Msg, G extends Graph = Graph> = (msg: Msg, graph: G) => void

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
export function runMessages<Msg, G extends Graph = Graph>(
  update: Update<Msg, G>,
  graph: G,
  messages: readonly Msg[],
): G {
  for (const msg of messages) {
    update(msg, graph)
  }
  return graph
}

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
export function createUpdate<
  Msg extends { kind: string },
  G extends Graph = Graph,
  Handlers extends {
    [K in Msg['kind']]: (msg: Extract<Msg, { kind: K }>, graph: G) => void
  } = {
    [K in Msg['kind']]: (msg: Extract<Msg, { kind: K }>, graph: G) => void
  },
>(handlers: Handlers): Update<Msg, G> {
  return (msg, graph) => {
    // Tag-driven dispatch: look up the handler by the message's
    // discriminator and refuse to silently no-op on an unknown tag.
    const handler = handlers[msg.kind as Msg['kind']]
    if (!handler) {
      throw new Error(`No handler for Msg kind "${String(msg.kind)}"`)
    }
    handler(msg as Extract<Msg, { kind: typeof msg.kind }>, graph)
  }
}
