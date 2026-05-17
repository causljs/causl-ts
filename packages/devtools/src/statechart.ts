/**
 * @packageDocumentation
 *
 * Statechart configuration display for the devtools surface.
 *
 * The previous draft had at least five state machines hiding as flat
 * enums (NodeStatus, ResourceNode.status, transaction-lifecycle steps,
 * conflict status, interaction mode), none of them with transition
 * rules and none of them composed against each other. The fix was to
 * define one composite statechart with hierarchy and orthogonal
 * regions:
 *
 * ```text
 * CauslLifecycle
 * ├── Engine                  (orthogonal region 1)
 * │   ├── Idle
 * │   └── Committing
 * │       ├── Staging
 * │       ├── Recomputing
 * │       ├── Validating
 * │       └── Publishing
 * ├── ResourceFleet            (orthogonal region 2: per-resource)
 * └── ConflictRegistry         (orthogonal region 3: per-conflict)
 * ```
 *
 * The four "policies" that previously named themselves separately are
 * guard expressions on transitions in this chart, sharing one event
 * vocabulary — they are no longer four independent enums. This module
 * computes the engine's current configuration (the active states across
 * the composite chart) and renders it as Mermaid for UI display.
 *
 * Phase 5 ships only the Engine orthogonal region, since that is the
 * only region implemented in `@causljs/core`. ResourceFleet and
 * ConflictRegistry regions are layered in by the host application
 * overlaying their per-resource / per-conflict sub-statecharts.
 */

import type { Graph } from '@causljs/core'

/**
 * Capability slice handed to {@link statechart}.
 *
 * Closes #364: the statechart capture is a snapshot of the current
 * configuration computed from `graph.now` alone. The full `Graph`
 * parameter that #257 left in place handed a getter `commit`,
 * `derived`, `input`, `hydrate`, and every other mutating handle — a
 * structural lie when the implementation reads exactly one property.
 * Per §12.3 the parameter exposes only `now`.
 *
 * Narrowing is type-level. A real `Graph` is still assignable, so call
 * sites keep working; the discipline is enforced at compile time inside
 * the implementation.
 */
export type StatechartGraph = Pick<Graph, 'now'>

/**
 * The active state of the Engine orthogonal region.
 *
 * @remarks
 * `Idle` is the resting configuration between commits; `Committing`
 * is held only for the duration of a synchronous commit body and is
 * therefore observable mainly from inside transaction callbacks.
 */
export type EngineState = 'Idle' | 'Committing'

/**
 * Snapshot of the composite statechart's current configuration.
 */
export interface StatechartConfiguration {
  /** Current configuration of the Engine orthogonal region. */
  readonly engine: EngineState
  /** Current GraphTime, exposed for UI labelling. */
  readonly graphTime: number
  /** The number of commits observed since the configuration started. */
  readonly commitCount: number
}

/**
 * Capture the current statechart configuration.
 *
 * @remarks
 * In a single-threaded JS engine, by the time a synchronous read
 * returns the engine is always in `Idle` between commits — so this
 * function is a snapshot, not a stream. For a streaming view, layer
 * it with `commitLog` and re-render on each commit.
 *
 * @param graph - The engine to inspect.
 * @returns A {@link StatechartConfiguration} for the current GraphTime.
 */
export function statechart(graph: StatechartGraph): StatechartConfiguration {
  // Engine is always Idle when a synchronous reader can observe it.
  return {
    engine: 'Idle',
    graphTime: graph.now,
    commitCount: graph.now,
  }
}

/**
 * Render the current configuration as a Mermaid `stateDiagram-v2` block.
 *
 * UI hosts call this and pipe the string into a `<pre class="mermaid">`
 * element. The active state is annotated with the current GraphTime
 * and observed commit count.
 *
 * @param config - Configuration produced by {@link statechart}.
 * @returns A newline-joined Mermaid source string.
 *
 * @example
 * ```ts
 * const mermaid = renderStatechartMermaid(statechart(graph))
 * element.textContent = mermaid
 * ```
 */
export function renderStatechartMermaid(config: StatechartConfiguration): string {
  // Identify the active state so the annotation lands on the right node.
  const active = config.engine

  // Assemble the Mermaid source line by line, ending with an annotation
  // showing the GraphTime and commit count for the active state.
  const lines = [
    'stateDiagram-v2',
    '    [*] --> Idle',
    '    Idle --> Committing : commit',
    '    Committing --> Idle : publish',
    `    note right of ${active}`,
    `      active @ t=${config.graphTime}`,
    `      ${config.commitCount} commits observed`,
    '    end note',
  ]
  return lines.join('\n')
}
