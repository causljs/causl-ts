/**
 * Compile-time fixture for `persistedInput` — pins the §13 boundary
 * "Refuses to wrap `graph.derived` (compile-time enforced)" against
 * silent widening. Runs under `tsd` from `package.json`'s `test:types`
 * script.
 *
 * Why this is a compile-time test, not a runtime test:
 *   The §13 boundary is a denotational property of the type system.
 *   Derived values are pure functions of inputs at the same `GraphTime`;
 *   persisting one would mean writing a stale cache the moment any
 *   upstream input or formula changes. The only honest enforcement is
 *   the type system — a runtime guard would either crash at hydration
 *   (too late) or accept the call and break glitch-freedom on the
 *   first divergent commit. tsd is what stops a future PR from
 *   widening `initial: T` to `T | NodeRef<T>` and quietly retiring
 *   the boundary.
 *
 * The positive companions ensure the constraint is *narrow*: it
 * refuses derived nodes specifically, not all generic `T`s. Without
 * them, an over-aggressive constraint that broke ordinary
 * `persistedInput(g, 'k', 0, opts)` could ship green by accident.
 */

import { createCausl, type InputNode } from '@causl/core'
import { expectAssignable, expectError } from 'tsd'
import { memoryAdapter, persistedInput } from '../src/index.js'

const graph = createCausl()
const storage = memoryAdapter()
const baseOpts = { key: 'tsd:k', storage, version: 1 } as const

// ---- positive: primitives typecheck ----------------------------------------
//
// The headline use case — a UI-preference value (column width, sort
// direction, theme key) is a primitive or a plain JSON-serialisable
// shape. These calls must continue to typecheck after the
// derived-refusal constraint lands; if they don't, the constraint is
// too aggressive and has broken the §7.2 surface.

expectAssignable<InputNode<number>>(persistedInput(graph, 'a', 0, baseOpts))
expectAssignable<InputNode<string>>(
  persistedInput(graph, 'b', 'hello', baseOpts),
)
expectAssignable<InputNode<boolean>>(persistedInput(graph, 'c', true, baseOpts))
expectAssignable<InputNode<readonly number[]>>(
  persistedInput(graph, 'd', [1, 2, 3] as readonly number[], baseOpts),
)
expectAssignable<InputNode<{ readonly width: number }>>(
  persistedInput(graph, 'e', { width: 200 } as const, baseOpts),
)
expectAssignable<InputNode<null>>(persistedInput(graph, 'f', null, baseOpts))

// ---- negative: derived nodes are refused ------------------------------------
//
// The §13 contract: `persistedInput` accepts only non-derived initial
// values. `graph.derived(...)` returns a `DerivedNode<T>`, and the
// `AssertNotDerived<T>` guard collapses the parameter to `never` for
// any union containing a derived node — so the call site fails to
// typecheck. tsd's `expectError` is the inverse of `@ts-expect-error`:
// it asserts that the wrapped expression is a type error.

const derivedSource = graph.derived('derived-source', () => 42)

expectError(persistedInput(graph, 'derived-1', derivedSource, baseOpts))

// A union containing a derived node is also refused — `AssertNotDerived`
// distributes `T extends DerivedNode<unknown>` over the union and then
// gates on `[…] extends [never]`, so any union member that is a derived
// node poisons the whole parameter. A future maintainer's "let's allow
// derived in a union" relaxation must trip a tsd failure, not silently
// compile.

declare const maybeDerived: number | typeof derivedSource
expectError(persistedInput(graph, 'derived-2', maybeDerived, baseOpts))
