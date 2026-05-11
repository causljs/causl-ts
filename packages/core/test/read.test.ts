/**
 * @packageDocumentation
 *
 * Pins down the contract of `graph.read(node)` — the synchronous snapshot
 * accessor. `read(node)` is one of the seven canonical public methods on
 * the engine surface, defined as "read at the current committed time
 * (outside a commit)". Tests verify that reads against inputs reflect the
 * latest committed value, that derived nodes recompute consistently with
 * their formula across commits, that reads are idempotent between commits
 * (no fractional time — between commits the graph is a fixed snapshot
 * because the only way time advances is through `commit`), that an
 * unregistered node descriptor faults with `UnknownNodeError` rather than
 * silently returning a wrong value (a runtime guard against fabricated
 * node handles), and that chained derivations propagate values correctly.
 */
import { describe, expect, it } from 'vitest'
import { createCausl, UnknownNodeError } from '../src/index.js'

/**
 * Suite covering read semantics: input snapshots, derived
 * recomputation, snapshot stability between commits, the unknown-node
 * fault, and multi-level derivation chains.
 */
describe('graph.read(node)', () => {
  /**
   * Reading an input returns its value at the most recent committed
   * time — initially the registration value, and after a commit the
   * newly set value.
   */
  it('reads input values at the current committed time', () => {
    // Arrange: a graph with one input.
    const g = createCausl()
    const a = g.input('a', 7)
    // Assert: initial read returns the t₀ value.
    expect(g.read(a)).toBe(7)
    // Act: commit a new value.
    g.commit('a→11', (tx) => tx.set(a, 11))
    // Assert: subsequent read reflects the committed value.
    expect(g.read(a)).toBe(11)
  })

  /**
   * Reading a derived node returns a value consistent with applying
   * its compute function to the current input snapshot.
   */
  it('reads derived values consistent with their compute', () => {
    // Arrange: an input and a derived square-of-input.
    const g = createCausl()
    const a = g.input('a', 3)
    const sq = g.derived('sq', (get) => get(a) * get(a))
    // Assert: derived value matches the formula at t₀.
    expect(g.read(sq)).toBe(9)
    // Act: commit a new input value.
    g.commit('a→4', (tx) => tx.set(a, 4))
    // Assert: derived recomputes against the new input.
    expect(g.read(sq)).toBe(16)
  })

  /**
   * Between commits the snapshot is stable — repeated reads return
   * the same committed value with no fractional time advance.
   */
  it('reads see committed snapshot (no fractional time outside commits)', () => {
    // Arrange: an input whose value is mutated once.
    const g = createCausl()
    const a = g.input('a', 0)
    expect(g.read(a)).toBe(0)
    g.commit('a→1', (tx) => tx.set(a, 1))
    expect(g.read(a)).toBe(1)
    // Assert: reads remain stable until the next commit.
    expect(g.read(a)).toBe(1)
    expect(g.read(a)).toBe(1)
  })

  /**
   * Reading via a node descriptor whose id is not registered in the
   * graph faults with `UnknownNodeError` rather than returning a
   * silently-wrong value.
   */
  it('throws UnknownNodeError when reading an unregistered node id', () => {
    // Arrange: a graph and a fabricated node descriptor for an id
    // that was never registered.
    const g = createCausl()
    const fake = { id: 'ghost' }
    // Assert: read rejects the unknown id.
    expect(() => g.read(fake)).toThrow(UnknownNodeError)
  })

  /**
   * A chain of derivations (a → b → c, plus c using b) produces
   * mutually consistent values when each is read in turn.
   */
  it('reads a chain of derivations consistently', () => {
    // Arrange: build a four-level chain.
    const g = createCausl()
    const a = g.input('a', 1)
    const b = g.derived('b', (get) => get(a) + 1)
    const c = g.derived('c', (get) => get(b) * 10)
    const d = g.derived('d', (get) => get(c) - get(b))
    // Assert: each level matches its formula evaluated against the
    // input value 1.
    expect(g.read(a)).toBe(1)
    expect(g.read(b)).toBe(2)
    expect(g.read(c)).toBe(20)
    expect(g.read(d)).toBe(18)
  })
})
