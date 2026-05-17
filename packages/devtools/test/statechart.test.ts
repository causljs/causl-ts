/**
 * @packageDocumentation
 *
 * Tests for the statechart introspection helpers exposed by
 * `@causljs/devtools`. Covers {@link statechart}, which materialises an
 * engine configuration snapshot (engine phase, `GraphTime`, commit count),
 * and {@link renderStatechartMermaid}, which projects that configuration
 * into a Mermaid `stateDiagram-v2` source string for documentation and
 * debugger surfaces.
 */

import { createCausl } from '@causljs/core'
import { describe, expect, it } from 'vitest'
import { renderStatechartMermaid, statechart } from '../src/index.js'

/**
 * Tests for {@link statechart}: the live introspection of engine phase and
 * temporal counters at the moment of inspection.
 */
describe('statechart(graph)', () => {
  /**
   * Confirms the configuration object reflects the engine being idle plus
   * the present `graphTime` and total commit count, both before and after a
   * commit advances the graph clock.
   */
  it('returns the engine configuration at the current GraphTime', () => {
    // Fresh graph: engine idle at t=0 with no commits recorded yet.
    const g = createCausl()
    const a = g.input('a', 0)
    expect(statechart(g)).toEqual({ engine: 'Idle', graphTime: 0, commitCount: 0 })
    // After one commit, both the clock and the commit counter advance in lockstep.
    g.commit('one', (tx) => tx.set(a, 1))
    expect(statechart(g)).toEqual({ engine: 'Idle', graphTime: 1, commitCount: 1 })
  })
})

/**
 * Tests for {@link renderStatechartMermaid}: the deterministic projection of
 * a statechart configuration into a Mermaid diagram source.
 */
describe('renderStatechartMermaid', () => {
  /**
   * Verifies the rendered Mermaid string contains the expected diagram header,
   * each named lifecycle node, and human-readable annotations for the current
   * tick and observed commit total.
   */
  it('renders a mermaid diagram with the active state and tick count', () => {
    // Synthetic configuration mirroring a graph at t=7 with 7 commits.
    const cfg = { engine: 'Idle' as const, graphTime: 7, commitCount: 7 }
    const md = renderStatechartMermaid(cfg)
    // Diagram preamble is mandatory for Mermaid to parse the block.
    expect(md).toContain('stateDiagram-v2')
    // Both lifecycle states must be represented as nodes in the diagram.
    expect(md).toContain('Idle')
    expect(md).toContain('Committing')
    // Annotation strings should reflect the live counters.
    expect(md).toContain('t=7')
    expect(md).toContain('7 commits observed')
  })
})
