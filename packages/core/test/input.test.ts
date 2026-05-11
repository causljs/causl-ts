/**
 * @packageDocumentation
 *
 * Pins down the contract of `graph.input(id, initial)`. An InputNode is one
 * of the two runtime kinds the engine has — `Node<T>` is either an
 * `InputNode<T>` (a writable Behavior) or a `DerivedNode<T>` (a Behavior
 * computed from other Behaviors), and the previous draft's eleven
 * `NodeKind` values were collapsed into exactly these two; everything else
 * (formula, selector, constraint, resource) is a role a node can play, not
 * a kind it permanently is. `input` is also one of the seven canonical
 * public methods we defend on every PR review — the smallest possible
 * expression of "writable Behavior". Tests verify that the returned node
 * descriptor carries the supplied id, that the initial value forms the
 * t₀ behaviour readable through `graph.read` (`input(initial)(t₀) =
 * initial` from the denotational definition), that arbitrary T is
 * preserved verbatim, that duplicate ids fault loudly with
 * `DuplicateNodeError`, that the returned descriptor is frozen, and that
 * two graphs maintain isolated namespaces.
 */
import { describe, expect, it } from 'vitest'
import { createCausl, DuplicateNodeError } from '../src/index.js'

/**
 * Suite covering construction-time guarantees of input nodes:
 * identity, initial-value capture, polymorphism over T, duplicate-id
 * rejection, descriptor immutability, and per-graph isolation.
 */
describe('graph.input(id, initial)', () => {
  /**
   * The descriptor returned by `input()` exposes the same id string
   * the caller supplied.
   */
  it('returns a Node carrying the supplied id', () => {
    // Arrange: a graph and a single registered input.
    const g = createCausl()
    const a = g.input('counter', 0)
    // Assert: the descriptor's id matches the registration argument.
    expect(a.id).toBe('counter')
  })

  /**
   * The initial value supplied at registration is the value visible
   * at logical time t = 0, before any commit advances the graph.
   */
  it('preserves the initial value as the t₀ behaviour', () => {
    // Arrange: register an input with a known initial value.
    const g = createCausl()
    const a = g.input<number>('a', 42)
    // Assert: read returns the initial value and no time has elapsed.
    expect(g.read(a)).toBe(42)
    expect(g.now).toBe(0)
  })

  /**
   * `input` is generic over T — primitives, objects, arrays and
   * `null` all round-trip through the input/read pair unchanged.
   */
  it('supports arbitrary T (numbers, strings, objects, arrays)', () => {
    // Arrange + Act + Assert: register one input per value type and
    // confirm the value comes back identical via `g.read`.
    const g = createCausl()
    expect(g.read(g.input('n', 1))).toBe(1)
    expect(g.read(g.input('s', 'hello'))).toBe('hello')
    expect(g.read(g.input('o', { x: 1 }))).toEqual({ x: 1 })
    expect(g.read(g.input('a', [1, 2, 3]))).toEqual([1, 2, 3])
    expect(g.read(g.input('b', null))).toBe(null)
  })

  /**
   * Registering two nodes under the same id within a single graph is a
   * programmer error and surfaces as `DuplicateNodeError` at registration
   * time. This is the API-design discipline that catches the duplicate-id
   * race class structurally — the engine will not silently overwrite a
   * prior registration; the second call faults so the conflict is
   * impossible to miss.
   */
  it('rejects duplicate ids with DuplicateNodeError', () => {
    // Arrange: register an input under id 'dup'.
    const g = createCausl()
    g.input('dup', 0)
    // Assert: a second registration under the same id throws.
    expect(() => g.input('dup', 1)).toThrow(DuplicateNodeError)
  })

  /**
   * The node descriptor returned by `input()` is frozen so consumers
   * cannot mutate id or kind at runtime.
   */
  it('returns a frozen node descriptor (id is readonly at runtime)', () => {
    // Arrange: register an input.
    const g = createCausl()
    const a = g.input('a', 0)
    // Assert: the descriptor is `Object.isFrozen`-tight.
    expect(Object.isFrozen(a)).toBe(true)
  })

  /**
   * Each `createCausl` call yields an independent namespace —
   * registering the same id in two graphs is allowed and the two
   * inputs hold their own values.
   */
  it('keeps inputs across two graphs independent', () => {
    // Arrange: two graphs each register an input under id 'a' but
    // with different initial values.
    const g1 = createCausl()
    const g2 = createCausl()
    const a1 = g1.input('a', 1)
    const a2 = g2.input('a', 2)
    // Assert: each graph reports its own initial value.
    expect(g1.read(a1)).toBe(1)
    expect(g2.read(a2)).toBe(2)
  })
})
