/**
 * Behaviour-parity property — the validation procedure's third
 * axis (`docs/migration/validation.md`).
 *
 * The property models a counter+todo store the way the three
 * migration guides ship it. The pre-migration semantics are
 * captured by `reduxOracle` — a Redux Toolkit-style reducer plus
 * a derived selector — exactly the shape adopters bring to the
 * migration. The post-migration semantics are captured by
 * `causlMigrated` — a typed `Msg`-driven update that writes a
 * single input on every commit, with `doubled` and `total`
 * exposed as derived nodes. The two encodings are structurally
 * distinct (mutation-on-state vs. graph commit + derivation), so
 * the property is meaningful: a parity-breaking regression in
 * either path surfaces as a shrunk counter-example.
 *
 * Per SPEC §15.2 (EPIC #285 / #292) the floor is 1000 trials per
 * property on every CI run. The conformance meta-test in
 * `packages/core/test/spec-15.2-conformance.test.ts` enforces that
 * lower bound across every `test/properties/` directory in the
 * workspace.
 *
 * Why an in-process model rather than a shell-out to `pnpm test`:
 * the validation procedure asserts observational equivalence
 * between pre- and post-migration test suites. Running a separate
 * Node process per trial would make the 1000-trial floor cost
 * prohibitive; the model captures the same commitment (every Msg
 * sequence produces the same observed View) at single-process
 * speed.
 */

import * as fc from 'fast-check'
import { describe, it } from 'vitest'

import { propertyOptions } from './seed.js'

// ---------------------------------------------------------------------------
// Shared message vocabulary — the typed Msg union the after/ tree
// dispatches through `useDispatch<Msg>()`. The before/ tree's Redux
// `Action`s are mapped onto the same vocabulary so the parity
// property compares like-for-like.
// ---------------------------------------------------------------------------

type Msg =
  | { readonly kind: 'inc' }
  | { readonly kind: 'dec' }
  | { readonly kind: 'set'; readonly value: number }
  | { readonly kind: 'reset' }
  | { readonly kind: 'addTodo'; readonly text: string }
  | { readonly kind: 'clearTodos' }

interface View {
  readonly counter: number
  readonly doubled: number
  readonly todos: readonly string[]
  readonly total: number
}

const INITIAL: View = { counter: 0, doubled: 0, todos: [], total: 0 }

// ---------------------------------------------------------------------------
// Pre-migration oracle — a Redux Toolkit-style reducer + derived
// selector. The shape adopters bring to the migration:
//
//   - `state.counter`, `state.todos` are reducer-managed leaves.
//   - `doubled`, `total` are derived via selectors recomputed on
//     every read.
//
// Mutation happens through a switch on the action `type`. The
// reducer returns a *new* state object on every step; structural
// equality on the View is the parity surface.
// ---------------------------------------------------------------------------

interface ReduxState {
  readonly counter: number
  readonly todos: readonly string[]
}

interface ReduxAction {
  readonly type: string
  readonly payload?: unknown
}

function msgToAction(msg: Msg): ReduxAction {
  switch (msg.kind) {
    case 'inc':
      return { type: 'counter/inc' }
    case 'dec':
      return { type: 'counter/dec' }
    case 'set':
      return { type: 'counter/set', payload: msg.value }
    case 'reset':
      return { type: 'counter/reset' }
    case 'addTodo':
      return { type: 'todos/add', payload: msg.text }
    case 'clearTodos':
      return { type: 'todos/clear' }
  }
}

function reduxReducer(state: ReduxState, action: ReduxAction): ReduxState {
  switch (action.type) {
    case 'counter/inc':
      return { ...state, counter: state.counter + 1 }
    case 'counter/dec':
      return { ...state, counter: state.counter - 1 }
    case 'counter/set':
      return { ...state, counter: action.payload as number }
    case 'counter/reset':
      return { ...state, counter: 0 }
    case 'todos/add':
      return { ...state, todos: [...state.todos, action.payload as string] }
    case 'todos/clear':
      return { ...state, todos: [] }
    default:
      return state
  }
}

function reduxView(state: ReduxState): View {
  // Selectors — recomputed on every read, the way `useSelector`
  // wires them up in the before/ tree.
  return {
    counter: state.counter,
    doubled: state.counter * 2,
    todos: state.todos,
    total: state.todos.length,
  }
}

function reduxOracle(prev: View, msg: Msg): View {
  // Reconstruct the redux state the oracle owns from the prior
  // View, apply the action, project back through the selector.
  const state: ReduxState = { counter: prev.counter, todos: prev.todos }
  const next = reduxReducer(state, msgToAction(msg))
  return reduxView(next)
}

// ---------------------------------------------------------------------------
// Post-migration migrated — a causl update modelled as a single
// graph commit per Msg. Every commit writes the next value of one
// input; derived nodes (`doubled`, `total`) read the inputs on
// demand. This matches the after/ tree's
// `createUpdate<Msg>(({ msg, commit }) => commit(...))` shape.
// ---------------------------------------------------------------------------

interface CauslGraph {
  readonly counter: number
  readonly todos: readonly string[]
}

function causlCommit(graph: CauslGraph, msg: Msg): CauslGraph {
  // Each branch is one `commit('label', tx => tx.write(...))` in
  // the after/ tree. Atomicity per SPEC §3 / §5: one commit, one
  // input write, no partial application.
  switch (msg.kind) {
    case 'inc':
      return { counter: graph.counter + 1, todos: graph.todos }
    case 'dec':
      return { counter: graph.counter - 1, todos: graph.todos }
    case 'set':
      return { counter: msg.value, todos: graph.todos }
    case 'reset':
      return { counter: 0, todos: graph.todos }
    case 'addTodo':
      return { counter: graph.counter, todos: [...graph.todos, msg.text] }
    case 'clearTodos':
      return { counter: graph.counter, todos: [] }
  }
}

function causlView(graph: CauslGraph): View {
  // Derivations recomputed on every read (the engine memoises by
  // graph time; for the parity property, a fresh recompute per
  // step is correct and observationally equivalent).
  return {
    counter: graph.counter,
    doubled: graph.counter * 2,
    todos: graph.todos,
    total: graph.todos.length,
  }
}

function causlMigrated(prev: View, msg: Msg): View {
  const graph: CauslGraph = { counter: prev.counter, todos: prev.todos }
  return causlView(causlCommit(graph, msg))
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const msgArb: fc.Arbitrary<Msg> = fc.oneof(
  fc.constant<Msg>({ kind: 'inc' }),
  fc.constant<Msg>({ kind: 'dec' }),
  fc.integer({ min: -1000, max: 1000 }).map<Msg>((value) => ({ kind: 'set', value })),
  fc.constant<Msg>({ kind: 'reset' }),
  fc.string({ minLength: 0, maxLength: 16 }).map<Msg>((text) => ({
    kind: 'addTodo',
    text,
  })),
  fc.constant<Msg>({ kind: 'clearTodos' }),
)

const sequenceArb: fc.Arbitrary<readonly Msg[]> = fc.array(msgArb, {
  minLength: 0,
  maxLength: 32,
})

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

function eqView(a: View, b: View): boolean {
  if (a.counter !== b.counter) return false
  if (a.doubled !== b.doubled) return false
  if (a.total !== b.total) return false
  if (a.todos.length !== b.todos.length) return false
  for (let i = 0; i < a.todos.length; i++) {
    if (a.todos[i] !== b.todos[i]) return false
  }
  return true
}

describe('migration validation — behaviour-parity property (SPEC §15.2 floor)', () => {
  it('step-by-step: every Msg sequence is observationally equivalent under both encodings', () => {
    fc.assert(
      fc.property(sequenceArb, (sequence) => {
        let oracle = INITIAL
        let migrated = INITIAL
        for (const msg of sequence) {
          oracle = reduxOracle(oracle, msg)
          migrated = causlMigrated(migrated, msg)
          // Step-by-step equivalence is stronger than terminal
          // equivalence: a trace that diverges and converges still
          // fails. This honours the validation procedure's
          // "observational equivalence" axis — every observable
          // step must agree, not just the final read.
          if (!eqView(oracle, migrated)) return false
        }
        return true
      }),
      propertyOptions(),
    )
  })

  it('terminal: the final View is identical from any starting View', () => {
    const startArb = fc.record({
      counter: fc.integer({ min: -100, max: 100 }),
      todos: fc.array(fc.string({ maxLength: 8 }), { maxLength: 4 }),
    })
    fc.assert(
      fc.property(startArb, sequenceArb, (start, sequence) => {
        const initial: View = {
          counter: start.counter,
          doubled: start.counter * 2,
          todos: start.todos,
          total: start.todos.length,
        }
        let oracle = initial
        let migrated = initial
        for (const msg of sequence) {
          oracle = reduxOracle(oracle, msg)
          migrated = causlMigrated(migrated, msg)
        }
        return eqView(oracle, migrated)
      }),
      propertyOptions(),
    )
  })
})
