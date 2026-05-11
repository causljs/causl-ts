/**
 * @packageDocumentation
 *
 * Pins down the contract of `graph.exportModel()` — the serialisation
 * boundary between a live causl graph and the schema-versioned
 * CauslModel IR.
 *
 * `exportModel` exists for one reason: the bounded model checker needs
 * an IR to consume. I committed to one new method on the engine —
 * `graph.exportModel(): CauslModel` — a JSON document describing
 * the registered nodes, the dependency edges (static and conditional),
 * the registered resources and their statechart, the registered
 * constraints, and the application's `Msg` union. That IR is the
 * bridge between the TS engine and the Rust checker, and it is the
 * only producer of the IR; if a future PR wants a second producer,
 * the bar is the same as for the rest of the public surface.
 *
 * Each test exercises a distinct facet of the exported snapshot:
 * empty-graph shape, faithful capture of inputs and derived nodes
 * with their dependency edges, the `maxCommits` truncation knob over
 * commit history, and the non-serialisable value escape hatch.
 * Assertions read the IR back directly and check schema number,
 * time, node identity, kind, value, dependency listings, and the
 * `serializable` flag.
 */
import { describe, expect, it } from 'vitest'
import { createCausl, CAUSL_MODEL_SCHEMA } from '../src/index.js'

/**
 * Suite covering the structural and behavioural contract of
 * `graph.exportModel()` across empty graphs, populated graphs,
 * commit-history truncation, and non-serialisable value handling.
 */
describe('graph.exportModel()', () => {
  /**
   * An untouched graph exports a model whose schema is pinned to 1,
   * whose logical time is 0, and whose node and commit lists are empty.
   */
  it('exports an empty graph', () => {
    // Arrange: a freshly created graph with no nodes or commits.
    const g = createCausl()
    // Act: serialise the graph state.
    const m = g.exportModel()
    // Assert: schema, time, and collections reflect a pristine graph.
    expect(m.schema).toBe(CAUSL_MODEL_SCHEMA)
    expect(m.time).toBe(0)
    expect(m.nodes).toEqual([])
    expect(m.commits).toEqual([])
  })

  /**
   * Inputs and derived nodes both surface in the exported model; their
   * `kind`, `id`, current `value`, and (for derived) declared `deps`
   * match the live graph after a commit.
   */
  it('exports inputs and derived nodes with their current values', () => {
    // Arrange: build a graph with two inputs, one derived node, then
    // mutate one input via a commit so logical time advances.
    const g = createCausl()
    const a = g.input('a', 1)
    const b = g.input('b', 2)
    g.derived('sum', (get) => get(a) + get(b))
    g.commit('bump', (tx) => tx.set(a, 10))
    // Act: capture the post-commit IR.
    const m = g.exportModel()
    // Assert: time advanced, all nodes are present, and each node
    // reports the expected kind, value, and dependency wiring.
    expect(m.time).toBe(1)
    const ids = m.nodes.map((n) => n.id).sort()
    expect(ids).toEqual(['a', 'b', 'sum'])
    const aNode = m.nodes.find((n) => n.id === 'a')!
    expect(aNode.kind).toBe('input')
    if (aNode.kind === 'input') expect(aNode.value).toBe(10)
    const sumNode = m.nodes.find((n) => n.id === 'sum')!
    expect(sumNode.kind).toBe('derived')
    if (sumNode.kind === 'derived') {
      expect(sumNode.deps).toEqual(['a', 'b'])
      expect(sumNode.value).toBe(12)
    }
  })

  /**
   * The `maxCommits` option truncates the commit-history tail of the
   * IR to at most the requested length, while leaving the rest of the
   * snapshot intact.
   */
  it('caps commit history at the requested maxCommits', () => {
    // Arrange: produce five commits against a single input. Explicit
    // `commitHistoryCap` because SPEC §5.1 Amendment 2 (#716) flipped
    // the default to 0; this test asserts that the in-engine ring
    // buffer is honoured by `exportModel`'s `maxCommits` projection,
    // which requires opt-in retention.
    const g = createCausl({ commitHistoryCap: 1000 })
    const a = g.input('a', 0)
    for (let i = 0; i < 5; i++) g.commit(`c${i}`, (tx) => tx.set(a, i + 1))
    // Act + Assert: a generous cap returns all five commits; a tight
    // cap returns only the last two.
    expect(g.exportModel({ maxCommits: 100 }).commits.length).toBe(5)
    expect(g.exportModel({ maxCommits: 2 }).commits.length).toBe(2)
  })

  /**
   * Values that cannot be safely serialised (e.g. functions) are
   * tagged `serializable: false` and their `value` is replaced by
   * `null` in the exported IR.
   */
  it('marks non-serialisable values appropriately', () => {
    // Arrange: an input whose value is a function — not JSON-safe.
    const g = createCausl()
    g.input<() => number>('fn', () => 7)
    // Act: export the model and locate the function-valued node.
    const m = g.exportModel()
    const fnNode = m.nodes.find((n) => n.id === 'fn')!
    // Assert: the node carries a `serializable: false` flag and the
    // value is sanitised to `null`.
    expect(fnNode.serializable).toBe(false)
    if (fnNode.kind === 'input') expect(fnNode.value).toBe(null)
  })

  /**
   * Two-primitive discipline (§4 / #359 / #368). Pins the closed
   * `kind` set the engine emits and the closed top-level shape:
   * any node-level `kind` outside `{'input','derived'}` is a
   * regression, and any top-level field outside `{'schema','time',
   * 'nodes','commits'}` is a regression. The earlier draft of the
   * IR carried a `'resource'` and a `'conflict'` arm in the
   * exportModel switch and an optional `resources` / `conflicts`
   * pair on the top-level shape; both surfaces were retired and
   * this test pins the retirement.
   */
  describe('§4 two-primitive discipline (#359 / #368)', () => {
    /**
     * Closed top-level shape — exactly four declared keys, in any
     * order. A future PR that re-introduces an optional `resources`
     * region trips this assertion before the change reaches review.
     */
    it('top-level shape is exactly schema | time | nodes | commits | events', () => {
      const g = createCausl()
      const a = g.input('a', 1)
      g.derived('two-a', (get) => 2 * get(a))
      g.commit('seed', (tx) => tx.set(a, 3))
      const m = g.exportModel()
      // Schema 3 (EPIC-1 PR-A) adds `events: readonly never[]` as the
      // forward-compatibility array for the lifecycle event stream;
      // PR-B1 adds `scopes` and `bridges` so EPIC-2's
      // SubscribeWithoutDispose / CrossGraphRead passes have a place
      // to read scope membership and sanctioned cross-graph deps from.
      // The top-level shape grows from five fields to seven; the
      // closure discipline holds — adding an eighth field requires a
      // schema bump.
      expect(Object.keys(m).sort()).toEqual([
        'bridges',
        'commits',
        'events',
        'nodes',
        'schema',
        'scopes',
        'time',
      ])
    })

    /**
     * Closed `kind` set on emitted nodes — every node tag is one of
     * the two §4 primitives. Mixed registrations and several commits
     * exercise the dispatch on both arms.
     */
    it('every emitted node carries kind in {input, derived}', () => {
      const g = createCausl()
      const a = g.input('a', 1)
      const b = g.input('b', 2)
      g.derived('sum', (get) => get(a) + get(b))
      g.derived('product', (get) => get(a) * get(b))
      g.commit('mix', (tx) => {
        tx.set(a, 4)
        tx.set(b, 5)
      })
      const tags = new Set(g.exportModel().nodes.map((n) => n.kind))
      expect(tags).toEqual(new Set(['input', 'derived']))
    })
  })
})
