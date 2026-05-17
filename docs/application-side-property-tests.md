# Application-side property tests

> The recipe SPEC §15.3 promises and §9.1's "Two app-level `Msg`s producing inconsistent intermediate model state" row points at. Engine guarantees nothing here; this page is the template the spec asks an adopter to write themselves.

## 0. Why this page exists

`SPEC.md` §15.3 lists three classes of bug property-based fuzz cannot prove absent. The third — **app-level logic races** in the application's own `update` function — is the only row whose closure depends on documentation rather than code. The engine's promise stops at the §3 invariants (atomicity, glitch-freedom, determinism) and the §9.1 catalogue of races those invariants eliminate. The moment an `update` clause reads back through the graph, branches on the value, and writes again, the engine is doing exactly what the §3 equation asks of it; what it cannot tell is whether the branch was the right one. That decision lives in the adopter's reducer, and so does the property that pins it.

The engine pins §3. The application pins app-level races. This page hands the adopter the property-pattern half of the second sentence.

The honest framing is: §15.3 §3 (the app-level race row) ends with a promise that the engine guarantees nothing, and `docs/checker-coverage.md` carries the same row as out-of-scope for the static linter. Without an in-repo recipe the adopter walks away from the spec knowing the engine does not check `update`, but with no template for the property pattern they are meant to write themselves. This page closes that gap. The same text the spec uses to disclaim coverage now also points here.

## 1. What an app-side property test pins

An app-level race is the class of bug where two `Msg`s, dispatched in some order an end-user can produce, leave the model in a state that no individual `Msg` could have written. The shapes that matter in practice:

- **Double-commit on the same `Msg`** — an optimistic-then-late-commit pattern that fires twice when the late commit was supposed to *replace*, not augment.
- **Stale-read inside `update`** — `update` reads the current value of an input, races with another `Msg` writing the same input, and the second commit overwrites the first instead of composing with it.
- **Order-sensitive convergence** — `update` clauses that commute when each is dispatched alone but diverge when interleaved.

Property-based fuzz is the right tool here for the same reason it is the right tool for §3 invariants: the state space is too large to enumerate by hand, and each class above has a one-line invariant that must hold for *every* `Msg` sequence the user can produce. A 1000-trial floor (§15.2) over a generated `Msg[]` is the cheapest viable gate that catches the class while staying inside one process.

## 2. The pattern

I write app-side properties as four pieces, in this order:

1. **A typed `Msg` union.** The same union the application's `useDispatch<Msg>()` accepts. Discriminated by `kind`.
2. **An `Update<Msg, Model>` (or its in-process equivalent).** What the app's `createUpdate<Msg>(...)` registers. The function under test.
3. **An oracle.** A second function with the *same* `(Model, Msg) → Model` shape, written at the level of abstraction the property is pinning. For the parity case it is a Redux-style reducer; for the no-double-commit case it is a counter that asserts each `Msg` advances time by exactly one. The oracle and the update do not have to agree on the implementation — they have to agree on the observable.
4. **A property.** Generate a random `Msg[]` with `fast-check`, dispatch through the update, observe via `subscribe` (or a step-by-step in-process model), assert the invariant against the oracle.

Wrap the call to `fc.assert` with `propertyTrials('your-label')` from `@causljs/core/testing` so the §15.2 1000-trial floor is enforced and the seed logs a reproducible `CAUSL_FUZZ_SEED=…` hint on failure.

`packages/core/test/spec-15.2-conformance.test.ts` walks the workspace and rejects any `fc.assert` below 1000 trials; the broadened walker post-#437 picks up `**/*.property.test.{ts,tsx}` anywhere under `packages/<pkg>/test/`, so a property suite added in `packages/<your-app>/test/` is mechanically gated without further wiring.

## 3. The in-repo reference

`packages/migration-check/test/properties/parity.property.test.ts` is 90% of the recipe and is the file I cite when asked for the canonical shape. Read it end-to-end before writing your own; the skeleton below is its load-bearing structure inlined for offline reading.

```ts
import * as fc from 'fast-check'
import { describe, it } from 'vitest'
import { propertyTrials } from '@causljs/core/testing'

// 1. The Msg union — the same one useDispatch<Msg>() accepts.
type Msg =
  | { readonly kind: 'inc' }
  | { readonly kind: 'dec' }
  | { readonly kind: 'set'; readonly value: number }
  | { readonly kind: 'reset' }

// 2. The View — what subscribers observe. Equivalent to the
//    selector outputs of useCausl in production.
interface View {
  readonly counter: number
  readonly doubled: number
}

const INITIAL: View = { counter: 0, doubled: 0 }

// 3. The oracle — the cleanest possible (View, Msg) -> View. No
//    optimisation, no caching, no graph. The property pins the
//    update to this.
function oracle(prev: View, msg: Msg): View {
  switch (msg.kind) {
    case 'inc':
      return { counter: prev.counter + 1, doubled: (prev.counter + 1) * 2 }
    case 'dec':
      return { counter: prev.counter - 1, doubled: (prev.counter - 1) * 2 }
    case 'set':
      return { counter: msg.value, doubled: msg.value * 2 }
    case 'reset':
      return { counter: 0, doubled: 0 }
  }
}

// 4. The migrated/under-test reducer — the in-process model of
//    what `createUpdate<Msg>(...)` plus `useCausl(graph =>
//    graph.read(node))` does. In a real test against a live
//    graph this is `dispatch(msg); flush(); read(view)`.
function migrated(prev: View, msg: Msg): View {
  // ...the app's actual update logic, projected to the same View shape.
  return oracle(prev, msg) // identity for the example.
}

// 5. The Msg arbitrary — the generator that produces the random
//    sequences. fast-check shrinks failures to a minimal counter-
//    example automatically.
const msgArb: fc.Arbitrary<Msg> = fc.oneof(
  fc.constant<Msg>({ kind: 'inc' }),
  fc.constant<Msg>({ kind: 'dec' }),
  fc.integer({ min: -1000, max: 1000 }).map<Msg>((value) => ({ kind: 'set', value })),
  fc.constant<Msg>({ kind: 'reset' }),
)

const sequenceArb: fc.Arbitrary<readonly Msg[]> = fc.array(msgArb, {
  minLength: 0,
  maxLength: 32,
})

describe('app-side property — Msg sequence parity', () => {
  it('every Msg sequence is observationally equivalent under both encodings', () => {
    fc.assert(
      fc.property(sequenceArb, (sequence) => {
        let oracleView = INITIAL
        let migratedView = INITIAL
        for (const msg of sequence) {
          oracleView = oracle(oracleView, msg)
          migratedView = migrated(migratedView, msg)
          // Step-by-step is stronger than terminal: a trace that
          // diverges and converges still fails. This is the
          // observational-equivalence axis.
          if (oracleView.counter !== migratedView.counter) return false
          if (oracleView.doubled !== migratedView.doubled) return false
        }
        return true
      }),
      propertyTrials('counter-msg-parity'),
    )
  })
})
```

The four ingredients are visible inline: a `Msg` union, an oracle, an under-test reducer, and a `fast-check` property over a `Msg[]` arbitrary. Substitute the under-test reducer with one that drives a real `Graph` via `createUpdate` and `subscribe` to pin a graph-backed `update` against the same oracle; that is the shape `parity.property.test.ts` ships in production for the migration-check suite.

## 4. Worked example: optimistic dispatch with late commit

The most common app-level race I see in adoption is the **optimistic-then-late-commit** pattern, where a `Msg` writes a provisional value through the graph, an async step resolves, and a second commit replaces the provisional with the canonical. The bug is straightforward: if the late commit fires twice (because the optimistic dispatch was fired twice before the first late commit landed), the model has been advanced by *two* logical messages but the user only pressed the button *once*.

The property: *for any `Msg` sequence, the count of canonical commits equals the count of `Msg`s dispatched.* The oracle is a counter; the under-test reducer is the optimistic-late-commit `Update`.

```ts
import * as fc from 'fast-check'
import { describe, it } from 'vitest'
import { propertyTrials } from '@causljs/core/testing'

type Msg = { readonly kind: 'submit'; readonly id: string }

interface Model {
  readonly committedIds: readonly string[]
  readonly pendingIds: readonly string[]
}

const INITIAL: Model = { committedIds: [], pendingIds: [] }

// Oracle: each Msg advances committedIds by exactly one entry.
function oracle(prev: Model, msg: Msg): Model {
  return {
    committedIds: [...prev.committedIds, msg.id],
    pendingIds: prev.pendingIds,
  }
}

// Under-test: optimistic write, then late commit. The race is
// whether the late commit can fire twice for one optimistic write.
// A correct update keys the late commit on the optimistic id and
// short-circuits if the id is already committed.
function migrated(prev: Model, msg: Msg): Model {
  // Optimistic: append to pending.
  const afterOptimistic: Model = {
    committedIds: prev.committedIds,
    pendingIds: [...prev.pendingIds, msg.id],
  }
  // Late commit: move from pending -> committed only if not already
  // present. The bug to catch is omitting the `.includes` guard, in
  // which case a re-fired late commit double-counts.
  if (afterOptimistic.committedIds.includes(msg.id)) {
    return afterOptimistic
  }
  return {
    committedIds: [...afterOptimistic.committedIds, msg.id],
    pendingIds: afterOptimistic.pendingIds.filter((p) => p !== msg.id),
  }
}

const msgArb: fc.Arbitrary<Msg> = fc
  .uuidV(4)
  .map<Msg>((id) => ({ kind: 'submit', id }))

const sequenceArb: fc.Arbitrary<readonly Msg[]> = fc.array(msgArb, {
  minLength: 0,
  maxLength: 32,
})

describe('app-side property — no double-commit on optimistic dispatch', () => {
  it('|committedIds| equals |Msg sequence| for every dispatch order', () => {
    fc.assert(
      fc.property(sequenceArb, (sequence) => {
        let oracleModel = INITIAL
        let migratedModel = INITIAL
        for (const msg of sequence) {
          oracleModel = oracle(oracleModel, msg)
          migratedModel = migrated(migratedModel, msg)
          if (oracleModel.committedIds.length !== migratedModel.committedIds.length) {
            return false
          }
        }
        return true
      }),
      propertyTrials('no-double-commit'),
    )
  })
})
```

The property catches the double-commit class without simulating async timing in the trial body itself. Two structural choices make that work: the oracle is the simplest possible (Model, Msg) → Model, and the under-test reducer projects the real optimistic-late-commit code into the same shape. If the real `Update` against a live graph passes the same `Msg[]` arbitrary and the same `committedIds` invariant, the same property covers it.

The same skeleton lifts to live-graph tests. Replace `migrated` with a function that creates a fresh `createCausl()`, registers the optimistic-late-commit `Update` via `createUpdate<Msg>(...)`, dispatches each generated `Msg` through `useDispatch<Msg>()` (or the in-process equivalent the SDK exposes for tests), waits for the late commit, and reads the resulting `committedIds` via `subscribe`. The property is unchanged; only the dispatch surface differs.

## 5. Bounds, seeds, and the §15.2 floor

`propertyTrials('label')` defaults to 1000 trials per property and refuses anything lower without an explicit `unsafeTrials: <n>` plus a documented rationale; the `causl/no-unsafe-trials` lint rule catches that escape hatch. The seed defaults to `CAUSL_FUZZ_SEED` if set in the environment, else a random seed logged on every run, so a CI failure replays on a developer machine via `CAUSL_FUZZ_SEED=<seed> pnpm test:run`.

The §15.2 conformance meta-test in `packages/core/test/spec-15.2-conformance.test.ts` walks every `**/*.property.test.{ts,tsx}` under `packages/<pkg>/test/` (the broadened walker post-#437) and rejects raw `fc.assert(prop, { numRuns: N })` literals plus `propertyTrials/propertyOptions` calls below 1000. App-side property suites added under any package's `test/` directory inherit the same gate without further wiring.

> **Post-0.9.0 update (PR #1097, issue #1073; cf. #1153).** The
> tier-budget system added `tieredPropertyTrials(label, options?)`
> alongside `propertyTrials`. Routing through the tiered variant
> picks up the active `CAUSL_FUZZ_TIER` (`default` / `pr` /
> `nightly` / `cargo-fuzz`) and `CAUSL_FUZZ_TRIALS` env overrides
> instead of pinning every callsite at the 1000-trial floor. App-
> side property suites that want PR-tier (5 000 trials) or
> nightly-tier (100 000 trials) heating without per-callsite
> plumbing should prefer `tieredPropertyTrials` over a hardcoded
> `numRuns`. The SPEC §15.2 floor is preserved either way — the
> tier system never drops below 1000.

## 6. Where this page is referenced

- `SPEC.md` §15.3 list item 3 — the app-level update-races bullet now points here as the recipe doc; `parity.property.test.ts` remains cited as the in-repo reference example.
- `docs/checker-coverage.md`'s §9.1 "Out of scope" row for app-level `Msg`s — the static linter treats `update` as opaque; this doc is the forward path the reader is meant to take.
- The `Two app-level Msgs producing inconsistent intermediate state` row in SPEC §9.1 ends in "Application-side property tests — engine guarantees nothing here." This page is the body of that promise.
