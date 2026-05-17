/**
 * @packageDocumentation
 *
 * Conflict registry implemented as a derived view over engine
 * primitives. The runtime universe is just `InputNode<T>` and
 * `DerivedNode<T>`; "conflict" is not a permanent node kind, it is a
 * role a derived view plays — a derived view of the engine's own
 * lifecycle. The registry's per-conflict sub-statechart is one of the
 * three orthogonal regions of the composite lifecycle, with states
 * `Open | Resolved | Ignored | Superseded` and three legal transitions
 * out of `Open` (resolve, ignore, supersede); the terminal three states
 * have no outgoing edges.
 *
 * The public {@link Conflict} surface is a SPEC §9 discriminated union
 * keyed on `kind`: each variant carries only the fields the statechart
 * guarantees in that state, so `{ kind: 'open', resolution: ... }` and
 * `{ kind: 'resolved' /* missing resolution *\/ }` are not
 * representable. Consumers narrow on `c.kind` and the type system
 * supplies the legal payload — there is no `c.resolution !== undefined`
 * runtime check left for callers.
 *
 * Two pieces compose into the registry: a derived node supplied by the
 * application that emits the CURRENT-OPEN conflict set, and an Input
 * node mapping conflict id to a resolution record. The exported
 * registry node is itself derived — it overlays the resolution map
 * onto the open set, producing the public Conflict stream that
 * observers subscribe to. Resolution mutations
 * ({@link ConflictRegistry.resolve}, {@link ConflictRegistry.ignore},
 * {@link ConflictRegistry.supersede}) each commit exactly one update to
 * the resolution Input, advancing GraphTime by one tick per call —
 * `commit` is the only way time advances.
 *
 * Capability narrowing per SPEC §7 / §12.3: each instance method
 * accepts the smallest engine slice that lets it do its job.
 * {@link ConflictRegistry.read} and {@link ConflictRegistry.subscribe}
 * take a {@link ConflictRegistryReadGraph}
 * (`Pick<Graph, 'read' | 'subscribe'>`); the mutators take a
 * {@link ConflictRegistryWriteGraph}
 * (`Pick<Graph, 'read' | 'commit' | 'now'>`). Only
 * {@link createConflictRegistry} keeps the full `Graph` — the
 * registration pass legitimately needs `input` and `derived`. A full
 * `Graph` remains assignable to either narrowed slice, so existing
 * call sites compile unchanged; what is now blocked is the
 * §7.2-failure shape of "controller-shaped state leaks into the
 * model layer" — a read-side consumer can no longer reach `commit`
 * through a registry method's parameter.
 */

import { assertNever } from '@causl/core/internal'
import type {
  Compute,
  DerivedNode,
  Graph,
  GraphTime,
  Node,
  NodeId,
} from '@causl/core'
import {
  type ConflictReducerState,
  type ConflictResolutionRecord,
  reduceConflict,
} from './statechart-reducers.js'

/**
 * Read-side capability slice handed to {@link ConflictRegistry.read}
 * and {@link ConflictRegistry.subscribe}.
 *
 * @remarks
 * Realises the SPEC §7 / §12.3 layering commitment at the registry
 * boundary: the read accessors only ever invoke `read` and
 * `subscribe`, and the parameter type proves it. A caller that hands
 * the registry a method reference cannot then reach for `commit`,
 * `input`, `derived`, `hydrate`, `exportModel`, … through the same
 * value — the surface is sealed at the type system rather than at the
 * call site.
 *
 * `Graph` is assignable to this slice, so existing call sites that
 * pass a full engine handle keep compiling. The narrowing is strict —
 * `ConflictRegistryReadGraph` cannot widen back to `Graph` without an
 * explicit cast, which is the lock the
 * `*.narrowCapability.test.ts` suite asserts.
 */
export type ConflictRegistryReadGraph = Pick<Graph, 'read' | 'subscribe'>

/**
 * Write-side capability slice handed to
 * {@link ConflictRegistry.resolve}, {@link ConflictRegistry.ignore},
 * and {@link ConflictRegistry.supersede}.
 *
 * @remarks
 * The mutators read the live conflict state to enforce the
 * Open → terminal guard, commit a single-tick patch to the
 * resolution Input, and stamp the GraphTime via `now`. They do not
 * register new nodes, do not call `derived`, do not subscribe, and do
 * not touch the export/hydrate surface; the parameter type proves it.
 *
 * Same §7 / §12.3 layering principle as
 * {@link ConflictRegistryReadGraph}: the registry is a state-class
 * editor, not an unrestricted authority over the engine.
 */
export type ConflictRegistryWriteGraph = Pick<Graph, 'read' | 'commit' | 'now'>

/**
 * Discriminator for the ConflictRegistry sub-statechart — the four
 * states reachable in the per-conflict orthogonal region of the
 * composite lifecycle.
 *
 * @remarks
 * - `open`: the application-supplied compute reports the conflict and
 *   no resolution record exists.
 * - `resolved`: a resolution was recorded; the application-supplied
 *   tag lives on the `resolved` variant's `resolution` member.
 * - `ignored`: the operator chose to suppress the conflict.
 * - `superseded`: another conflict subsumed this one; the linkage is
 *   carried on the `superseded` variant's `supersededBy` member.
 *
 * Only `open` has outgoing edges. The other three are terminal — no
 * legal transition leaves them.
 */
export type ConflictKind = 'open' | 'resolved' | 'ignored' | 'superseded'

/**
 * Status reported by {@link ForbiddenConflictTransitionError.from} when
 * the offending mutator targets a conflict id the registry has never
 * observed. The conflict sub-statechart has no `unknown` state, so this
 * synthetic tag is the closest honest report; adapter UIs branch on it
 * to distinguish "registry has never seen this id" from "id is in a
 * terminal state."
 *
 * @internal
 */
type ForbiddenFromKind = ConflictKind | 'unknown'

/**
 * Thrown when a {@link ConflictRegistry} mutator targets a conflict
 * that is not in the `open` state, or that the registry has never
 * observed.
 *
 * @remarks
 * The composite statechart specifies three transitions out of `Open`:
 * `resolve`, `ignore`, `supersede`. There are no edges leaving
 * `Resolved`, `Ignored`, or `Superseded` — those are terminal states.
 * Shipping enum tags whose transitions are not specified by the
 * statechart is one of the explicit don'ts of the engine's
 * commitments, so a forbidden transition surfaces as a typed error
 * rather than a silent no-op.
 *
 * The error carries enough metadata for adapter UIs to route the
 * failure to a useful operator-facing message: which conflict id
 * was targeted, what the current kind was, and which transition
 * was attempted.
 */
export class ForbiddenConflictTransitionError extends Error {
  override readonly name = 'ForbiddenConflictTransitionError'

  constructor(
    /** Identifier of the conflict the mutator was called against. */
    readonly id: NodeId,
    /** The conflict's current kind, or `'unknown'` if not registered. */
    readonly from: ForbiddenFromKind,
    /** The kind the rejected mutator would have moved it to. */
    readonly to: 'resolved' | 'ignored' | 'superseded',
  ) {
    super(
      `Forbidden conflict transition: ${from} → ${to} on '${id}'. ` +
        `Only Open → ${to} is permitted by the conflict statechart.`,
    )
  }
}

/**
 * Members carried by every public conflict regardless of lifecycle
 * state — the always-true facts the registry promises about an entry
 * in any of the four sub-statechart positions.
 *
 * @remarks
 * Pulled out so each variant of {@link Conflict} carries the same
 * always-present fields without inviting drift between variants. Each
 * variant intersects this with the per-state members the statechart
 * proves are present.
 *
 * @typeParam T - Application payload type carried by the conflict.
 */
export interface ConflictBase<T> {
  /** Stable identifier; matches the application's conflict identity. */
  readonly id: NodeId
  /** The node id this conflict relates to. */
  readonly target: NodeId
  /** The conflict payload (the offending value, validation snapshot, etc.). */
  readonly value: T
  /** GraphTime at which the conflict first appeared in the open set. */
  readonly raisedAt: GraphTime
}

/**
 * Public shape of a conflict surfaced by a {@link ConflictRegistry}.
 *
 * @remarks
 * SPEC §9 discriminated union: every variant carries exactly the
 * fields the statechart guarantees in that state. `kind: 'open'` has
 * no resolution; `kind: 'resolved'` carries the application-supplied
 * tag (opaque to the registry, so the resolution slot is `unknown`)
 * and the GraphTime of the resolution; `kind: 'ignored'` carries the
 * GraphTime of the suppression; `kind: 'superseded'` carries the
 * linkage to the subsuming conflict id and the GraphTime of the
 * supersession.
 *
 * Consumers narrow on `c.kind` and let `tsc` enforce that only legal
 * fields are reachable per state. There is no `resolution?: unknown`
 * optional field — that shape was the §9 violation this union
 * eliminates.
 *
 * @typeParam T - Application payload type carried by the conflict.
 */
export type Conflict<T> =
  | (ConflictBase<T> & { readonly kind: 'open' })
  | (ConflictBase<T> & {
      readonly kind: 'resolved'
      /** Application-supplied opaque tag committed via {@link ConflictRegistry.resolve}. */
      readonly resolution: unknown
      /** GraphTime at which Open → Resolved fired. */
      readonly resolvedAt: GraphTime
    })
  | (ConflictBase<T> & {
      readonly kind: 'ignored'
      /** GraphTime at which Open → Ignored fired. */
      readonly ignoredAt: GraphTime
    })
  | (ConflictBase<T> & {
      readonly kind: 'superseded'
      /** Conflict id of the entry that subsumed this one. */
      readonly supersededBy: NodeId
      /** GraphTime at which Open → Superseded fired. */
      readonly supersededAt: GraphTime
    })

/**
 * Internal resolution record shape stored in the Input map.
 *
 * @remarks
 * Discriminated on `kind` (mirrors the public {@link Conflict} tag);
 * each variant carries the GraphTime `at` which the transition was
 * committed and any payload supplied by the caller of the matching
 * mutator. The shape lives in `./statechart-reducers.ts` (the
 * `ConflictResolutionRecord` type) so the pure reducer is the single
 * source of truth for the record's tagged-union arms; this alias
 * keeps the local name for readability while routing through the
 * carve-out module #698 introduced.
 */
type ResolutionRecord = ConflictResolutionRecord

/**
 * Configuration accepted by {@link createConflictRegistry}.
 *
 * @typeParam T - Application payload type carried by the conflict.
 */
export interface ConflictRegistryOptions<T> {
  /** Stable {@link NodeId} for the registry's public derived node. */
  readonly id: NodeId
  /** Compute the current OPEN conflict set; the registry overlays the lifecycle tag. */
  readonly compute: Compute<readonly ConflictBase<T>[]>
}

/**
 * Public surface of the registry: a derived node plus mutators that
 * commit changes to the resolution Input.
 *
 * @typeParam T - Application payload type carried by the conflict.
 */
export interface ConflictRegistry<T> {
  /**
   * Derived node carrying the public conflict stream with statuses
   * overlaid. Subscribable like any other engine node.
   */
  readonly node: DerivedNode<readonly Conflict<T>[]>
  /**
   * Read the current conflict list from the supplied graph.
   *
   * @remarks
   * The parameter is narrowed to {@link ConflictRegistryReadGraph};
   * a full `Graph` is assignable so existing call sites keep compiling.
   */
  read(graph: ConflictRegistryReadGraph): readonly Conflict<T>[]
  /**
   * Subscribe to changes; the observer fires once per commit when the
   * registry's value changes.
   *
   * @remarks
   * The parameter is narrowed to {@link ConflictRegistryReadGraph}.
   */
  subscribe(
    graph: ConflictRegistryReadGraph,
    observer: (conflicts: readonly Conflict<T>[]) => void,
  ): () => void
  /**
   * Mark a conflict as resolved. The `resolution` is opaque to the
   * registry and surfaced on the `kind: 'resolved'` variant's
   * `resolution` member.
   *
   * @remarks
   * The parameter is narrowed to {@link ConflictRegistryWriteGraph} —
   * the mutator only needs `read` (statechart guard), `commit` (patch
   * the resolution Input), and `now` (GraphTime stamp).
   */
  resolve(
    graph: ConflictRegistryWriteGraph,
    id: NodeId,
    resolution?: unknown,
  ): void
  /** Mark a conflict as ignored. */
  ignore(graph: ConflictRegistryWriteGraph, id: NodeId): void
  /** Mark a conflict as superseded by another conflict id. */
  supersede(
    graph: ConflictRegistryWriteGraph,
    id: NodeId,
    bySupersedingId: NodeId,
  ): void
}

/**
 * Construct a {@link ConflictRegistry} on `graph`.
 *
 * @remarks
 * Three engine objects are allocated:
 *
 * 1. An Input node `${id}::__resolutions` carrying the resolution map.
 * 2. A Derived node `${id}::__open` wrapping the application-supplied
 *    compute that produces partial open-set entries (no `kind` tag).
 * 3. A Derived node at `id` that overlays the resolution map onto the
 *    open set; this is the {@link ConflictRegistry.node} the public
 *    API exposes.
 *
 * The mutators do not touch the open-set compute — they only patch the
 * resolution Input, so an application can keep recomputing its open set
 * freely while resolutions persist across re-emissions of the same
 * conflict id.
 *
 * @typeParam T - Application payload type carried by the conflict.
 * @param graph - Engine instance against which to register the nodes.
 * @param options - Registry id and the open-set compute.
 * @returns A {@link ConflictRegistry} bound to `graph`.
 */
export function createConflictRegistry<T>(
  graph: Graph,
  options: ConflictRegistryOptions<T>,
): ConflictRegistry<T> {
  // Backing Input for resolution records, keyed by conflict id. The
  // map is treated immutably — every patch produces a new Map.
  const resolutionsId = `${options.id}::__resolutions`
  const resolutions = graph.input<ReadonlyMap<NodeId, ResolutionRecord>>(
    resolutionsId,
    new Map(),
  )

  // Wrap the application's open-set compute in its own derived node so
  // it participates in the engine's dependency tracking.
  const openSetId = `${options.id}::__open`
  const openSet = graph.derived(openSetId, options.compute)

  // The public registry node: overlay resolution records on top of the
  // open set to produce the Conflict[] surface.
  const node = graph.derived<readonly Conflict<T>[]>(options.id, (get) => {
    const open = get(openSet)
    const resolved = get(resolutions)
    const out: Conflict<T>[] = []
    for (const partial of open) {
      const r = resolved.get(partial.id)
      // Resolution branch: no record present -> still Open.
      if (!r) {
        out.push({ ...partial, kind: 'open' })
        continue
      }
      switch (r.kind) {
        // Resolution branch: explicit resolved with opaque tag carried
        // through to the public Conflict.
        case 'resolved':
          out.push({
            ...partial,
            kind: 'resolved',
            resolution: r.value,
            resolvedAt: r.at,
          })
          break
        // Resolution branch: operator-suppressed.
        case 'ignored':
          out.push({ ...partial, kind: 'ignored', ignoredAt: r.at })
          break
        // Resolution branch: another conflict subsumed this one. The
        // linkage and the supersession GraphTime are surfaced on the
        // public shape so callers no longer have to reach into the
        // registry's mutators to recover it (the lossy old behaviour).
        case 'superseded':
          out.push({
            ...partial,
            kind: 'superseded',
            supersededBy: r.bySupersedingId,
            supersededAt: r.at,
          })
          break
        default:
          return assertNever(r, 'unhandled ResolutionRecord kind')
      }
    }
    return out
  })

  /**
   * Patch the resolution Input atomically — read the current map,
   * produce a new one with `record` set under `id`, and commit. Each
   * call advances GraphTime by exactly one tick: `commit` is the only
   * mutation API and produces exactly one new GraphTime per call.
   */
  function patch(
    graph: ConflictRegistryWriteGraph,
    id: NodeId,
    record: ResolutionRecord,
  ): void {
    const current = graph.read(resolutions)
    const next = new Map(current)
    next.set(id, record)
    graph.commit(`conflict:${record.kind}:${id}`, (tx) => tx.set(resolutions, next))
  }

  /**
   * Determine the current ConflictKind of an id. The registry's
   * public node holds the overlaid view; resolution records pin
   * terminal kinds (resolved/ignored/superseded), and an id that
   * the open-set compute currently emits but which has no resolution
   * record is `open`. An id absent from both is `unknown`.
   *
   * This is the I/O side of the registration shell — the only piece
   * of the mutator path that reads from the graph. The pure reducer
   * in `./statechart-reducers.ts` consumes the value returned here.
   *
   * @internal
   */
  function currentKindOf(
    g: ConflictRegistryWriteGraph,
    id: NodeId,
  ): ConflictReducerState {
    const resolved = g.read(resolutions).get(id)
    if (resolved !== undefined) return resolved.kind
    // No resolution record — check whether the id is in the live open set.
    const open = g.read(openSet)
    for (const c of open) if (c.id === id) return 'open'
    return 'unknown'
  }

  /**
   * Wiring shell for one mutator call. Reads the current state from
   * the graph, asks the pure {@link reduceConflict} reducer to decide
   * whether the requested edge is legal, and either commits the
   * resulting resolution record (on `ok`) or throws
   * {@link ForbiddenConflictTransitionError} (on `forbidden`). The
   * decision logic — what counts as legal, which records get written —
   * lives in the reducer module so the future Rust port (#698 / #680)
   * can pick it up without re-deriving the chart.
   *
   * @internal
   */
  function applyEvent(
    g: ConflictRegistryWriteGraph,
    id: NodeId,
    event: Parameters<typeof reduceConflict>[1],
  ): void {
    const from = currentKindOf(g, id)
    const result = reduceConflict(from, event, g.now, id)
    if (result.kind === 'forbidden') {
      // The reducer's `to` is already a ConflictKind terminal — narrow
      // it for the public error constructor.
      const to = result.reason.to as 'resolved' | 'ignored' | 'superseded'
      throw new ForbiddenConflictTransitionError(
        id,
        result.reason.from as ForbiddenFromKind,
        to,
      )
    }
    patch(g, id, result.next)
  }

  return {
    node,
    read(g) {
      return g.read(node)
    },
    subscribe(g, observer) {
      return g.subscribe(node, observer)
    },
    resolve(g, id, resolution) {
      // Open → Resolved is the only edge into the Resolved terminal.
      applyEvent(g, id, { kind: 'resolve', resolution })
    },
    ignore(g, id) {
      // Open → Ignored is the only edge into the Ignored terminal.
      applyEvent(g, id, { kind: 'ignore' })
    },
    supersede(g, id, bySupersedingId) {
      // Open → Superseded is the only edge into the Superseded terminal.
      applyEvent(g, id, { kind: 'supersede', bySupersedingId })
    },
  }
}

/**
 * Helper: compute factory that emits a single open conflict whenever a
 * supplied node satisfies `predicate`. The registry overlays the
 * lifecycle tag.
 *
 * @remarks
 * Convenient for the common case of "raise a conflict whenever this
 * one node violates this one rule". For richer scenarios (conflicts
 * derived from multiple nodes, conflicts with structured ids) callers
 * should write a bespoke {@link Compute} directly.
 *
 * @typeParam T - Value type carried by the source node.
 * @param source - The node observed to determine conflict presence.
 * @param predicate - Returns `true` to raise a conflict for the
 *   current value.
 * @param describe - Builds the partial conflict shape (id, target)
 *   from the current value and GraphTime; the registry fills in
 *   `value`, `raisedAt`, and the eventual `kind`.
 * @returns A {@link Compute} suitable for {@link
 *   ConflictRegistryOptions.compute}.
 */
export function singleConflictWhen<T>(
  source: Node<T>,
  predicate: (value: T) => boolean,
  describe: (
    value: T,
    time: GraphTime,
  ) => Pick<ConflictBase<T>, 'id' | 'target'>,
): Compute<readonly ConflictBase<T>[]> {
  return (get) => {
    const v = get(source)
    if (!predicate(v)) return []
    const partial = describe(v, 0)
    return [
      {
        id: partial.id,
        target: partial.target,
        value: v,
        raisedAt: 0,
      },
    ]
  }
}
