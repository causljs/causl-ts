/**
 * @packageDocumentation
 *
 * Behavioural tests for the snapshot subsystem of `@causljs/devtools`.
 * Exercises {@link exportSnapshot} / {@link importSnapshot} together with
 * their JSON convenience wrappers, ensuring captured state round-trips
 * across graph instances, that imports collapse into a single commit, and
 * that the schema gate plus graceful key-skipping behaviours hold under
 * forward/backward evolution.
 */

import { createCausl, type InputNode } from '@causljs/core'
import { describe, expect, it } from 'vitest'
import {
  exportSnapshot,
  exportSnapshotJson,
  importSnapshot,
  importSnapshotJson,
} from '../src/index.js'

/**
 * Top-level grouping for snapshot serialisation guarantees: capture, restore,
 * JSON round-trip, schema rejection, and tolerance for unknown keys.
 */
describe('Snapshot export/import', () => {
  /**
   * Verifies that {@link exportSnapshot} freezes the current input values and
   * tags the payload with the graph's present `GraphTime`.
   */
  it('exportSnapshot captures input values at the current GraphTime', () => {
    // Build a fresh graph with two inputs of differing primitive types.
    const g = createCausl()
    const a = g.input('a', 1)
    const b = g.input('b', 'hello')
    // Mutate one input so the snapshot reflects post-commit state, not seeds.
    g.commit('a→7', (tx) => tx.set(a, 7))
    // Capture the present moment as a structured snapshot payload.
    const snap = exportSnapshot(g, { inputs: [a, b] as InputNode<unknown>[] })
    // Schema, time, and value-map must all line up with the committed state.
    expect(snap.schema).toBe(1)
    expect(snap.time).toBe(1)
    expect(snap.inputs).toEqual({ a: 7, b: 'hello' })
  })

  /**
   * Confirms {@link importSnapshot} hydrates a destination graph atomically:
   * every restored value must land within a single commit so observers see
   * exactly one tick advance regardless of payload size.
   */
  it('importSnapshot re-applies values in a single commit', () => {
    // Empty destination graph with matching input identifiers.
    const dest = createCausl()
    const a = dest.input<number>('a', 0)
    const b = dest.input<string>('b', '')
    // Replay an external payload through the import helper, mapping ids to nodes.
    importSnapshot(
      dest,
      { schema: 1, time: 5, inputs: { a: 99, b: 'world' } },
      {
        inputs: new Map<string, InputNode<unknown>>([
          ['a', a as InputNode<unknown>],
          ['b', b as InputNode<unknown>],
        ]),
      },
    )
    // Restored values are observable via standard reads.
    expect(dest.read(a)).toBe(99)
    expect(dest.read(b)).toBe('world')
    expect(dest.now).toBe(1) // exactly one commit per import
  })

  /**
   * End-to-end check that {@link exportSnapshotJson} and
   * {@link importSnapshotJson} preserve all input values across a
   * serialise/parse boundary, treating the JSON string as an opaque transport.
   */
  it('JSON helpers round-trip', () => {
    // Source graph with mutated inputs to be serialised to JSON text.
    const src = createCausl()
    const a = src.input<number>('a', 1)
    const b = src.input<string>('b', 'hello')
    src.commit('bump', (tx) => {
      tx.set(a, 42)
      tx.set(b, 'snapshot')
    })
    const json = exportSnapshotJson(src, {
      inputs: [a, b] as InputNode<unknown>[],
    })

    // Independent destination graph hydrated from the JSON payload.
    const dest = createCausl()
    const a2 = dest.input<number>('a', 0)
    const b2 = dest.input<string>('b', '')
    importSnapshotJson(dest, json, {
      inputs: new Map<string, InputNode<unknown>>([
        ['a', a2 as InputNode<unknown>],
        ['b', b2 as InputNode<unknown>],
      ]),
    })
    // Both values must survive the textual round-trip exactly.
    expect(dest.read(a2)).toBe(42)
    expect(dest.read(b2)).toBe('snapshot')
  })

  /**
   * Guards against silent data corruption: a payload tagged with an unknown
   * schema version must be rejected at the boundary rather than partially
   * applied to the destination graph.
   */
  it('rejects unsupported schemas', () => {
    const g = createCausl()
    g.input<number>('a', 0)
    // Crafted payload with a future/unsupported schema id should throw.
    expect(() =>
      importSnapshot(g, { schema: 999 as unknown as 1, time: 0, inputs: {} }, {
        inputs: new Map<string, InputNode<unknown>>(),
      }),
    ).toThrow(/Unsupported snapshot schema/)
  })

  /**
   * Asserts forward-compatibility: payload entries that have no corresponding
   * input in the destination's mapping are skipped without error, allowing a
   * schema to shrink between serialisation and replay.
   */
  it('skips inputs not present in the destination map (graceful evolution)', () => {
    // Destination only knows about 'a'; the payload also carries a 'ghost' key.
    const dest = createCausl()
    const a = dest.input<number>('a', 0)
    importSnapshot(
      dest,
      { schema: 1, time: 0, inputs: { a: 1, ghost: 99 } },
      {
        inputs: new Map<string, InputNode<unknown>>([['a', a as InputNode<unknown>]]),
      },
    )
    // Known input is restored; unknown key is dropped silently.
    expect(dest.read(a)).toBe(1) // ghost silently skipped
  })
})
