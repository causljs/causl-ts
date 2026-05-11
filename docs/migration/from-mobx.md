# Migrating from MobX to Causl

Companion to `from-jotai.md` and `from-redux.md`. The contract that
backs this guide is `docs/migration/RULE_CATALOGUE.md`; the drift
detector `causl-migration-check` (see `packages/migration-check`)
flags un-migrated patterns in CI by rule ID. There is no codemod
and we do not plan to ship one — the migration is hand-written
under the rule catalogue's guidance. The drift detector classifies
findings; it does not transform source.

## Mapping at a glance

| MobX                                  | Causl                                                  | Mechanical? |
| --- | --- | --- |
| `observable.box(initial)`             | `graph.input(id, initial)`                                 | yes         |
| `computed(() => …)`                   | `graph.derived(id, (get) => …)`                            | yes         |
| `runInAction(() => …)`                | `graph.commit(intent, tx => …)`                            | yes         |
| `autorun(() => …)`                    | `graph.subscribe(node, observer)`                          | yes         |
| `reaction(() => x, (x) => …)`         | `graph.subscribe(derived, (x) => …)` over the projection   | structural  |
| `observable({ x: 1, y: 2 })`          | one input per field                                        | structural  |
| `@observable` class fields            | construct inputs in a factory function                     | manual      |
| `observer(() => Component)`           | `useCausl((g) => g.read(...))`                          | yes         |

## Why `observable({ a, b, c })` becomes one-input-per-field

MobX's deep proxies make every nested mutation a separate
notification. Causl's atomic-commit model means **one user
action = one commit**. If you genuinely want a coarse-grained
"the whole record changed" notification, model it as a single
`graph.input<{ a: T; b: U }>(id, ...)` and emit one commit per
record-change. The drift detector flags record-shaped observables
but never auto-flattens them — it's a semantic decision; see
`docs/migration/RULE_CATALOGUE.md` for the rule.

## Worked example: a TodoStore

**Before (MobX):**

```ts
class TodoStore {
  @observable todos: Todo[] = []
  @action addTodo(t: Todo) { this.todos.push(t) }
  @computed get pending() { return this.todos.filter(t => !t.done).length }
}
```

**After (Causl):**

```ts
import { createCausl } from '@causl/core'
import { createUpdate, useCausl } from '@causl/react'

const graph = createCausl()
const todos = graph.input<readonly Todo[]>('todos', [])
const pending = graph.derived('pending', (get) =>
  get(todos).filter((t) => !t.done).length,
)

// Messages carry the *next* list, not a delta the handler reads
// back. This honours rule `S-03` in
// `docs/migration/RULE_CATALOGUE.md`: the read needed to construct
// the next list happens at the dispatch site (the React component
// or thunk), not inside the commit's `tx` callback.
type Msg = { kind: 'replace'; next: readonly Todo[] }

const update = createUpdate<Msg>({
  replace: (msg, g) => {
    g.commit('replace-todos', (tx) => tx.set(todos, msg.next))
  },
})

// At the dispatch site:
//   const current = g.read(todos)
//   dispatch({ kind: 'replace', next: [...current, newTodo] })
```

Note: `todos` becomes a `readonly Todo[]` input; mutation is a
replace, not an in-place push. This is a deliberate divergence —
Causl's deterministic-replay invariant requires every input to be
replaceable on hydrate.

> **Note on §8.** Per #377, the runner is now `Update<Msg, Graph> =
> (msg, graph) => void`. Each handler issues exactly one
> `graph.commit(...)` and returns nothing — the graph is a stable
> handle whose `now` advances per commit, so the prior `return g`
> carried no information. Rule `S-02` in the catalogue still flags
> hand-written handlers that return their `graph` argument so the
> linter remains useful when migrating older code.

## `runInAction` and atomicity

MobX's `runInAction(() => { x.set(1); y.set(2) })` is the literal
equivalent of `graph.commit('intent', tx => { tx.set(x, 1); tx.set(y, 2) })`.
The drift detector reports any `runInAction` block surviving in
migrated source as rule `M-04`; collapse the body into one commit:

```ts
// Before
runInAction(() => {
  store.x = 1
  store.y = 2
})

// After
graph.commit('update-xy', (tx) => {
  tx.set(x, 1)
  tx.set(y, 2)
})
```

Both writes land at the same `GraphTime`; subscribers see a single
notification per node, and the §5 atomicity guarantee holds.

## Reactions vs subscribe

`reaction(() => store.x, (x) => sideEffect(x))` becomes
`graph.subscribe(xDerived, (x) => sideEffect(x))` where `xDerived`
projects the `x` slice. Important: Causl does not fire on
reference-equality differences — subscribe respects `Object.is`. If
the reaction was firing on every reference change, the migration
needs a non-Object.is comparator (or a derived that captures version
counter).

## Current state (as of v0.9.0): `read()` and reference identity

MobX's deep proxies guarantee a stable JS reference for an
`observable` until the next `runInAction` that touches it; observer
code routinely keys `React.memo` or downstream `useMemo` off that
identity. Causl's `useCausl((g) => g.read(node))` *today* gives
you the same behaviour on the JS engine — but per the **SPEC §15.1
amendment (#1124)**, reference identity across calls is **not**
contractually guaranteed. Today's `WasmBackend` is a TS-engine
wrapper, so an object-valued `read()` returns the same reference
trivially; the day the real Rust `serde`/`wasmgc` bridges land per
§17.6, `read()` will return a fresh object per call as the value is
deserialised across the FFI boundary. Adopters who depend on
identity for memoisation will silently re-render every commit once
they `migrate('wasm')`.

If your migrating MobX code keys memoisation off the read return,
port it to key off the per-commit `GraphTime` (read via
`useCausl((g) => g.now)`) or the per-node version counter
`EngineTelemetry` surfaces — not the object reference. Contractual
identity is **value identity**:
`Object.is(read(node)@t, read(node)@t)` holds for two synchronous
reads at the same `GraphTime`; cross-commit identity is
backend-dependent. Cross-link: `docs/wasm-adoption-guide.md` H1.

## Current state (as of v0.9.0): the capability-cost residual band

MobX is the head-to-head benchmark anchor for Causl's
replay-determinism commitment. **SPEC §17.5 commitment 13 (PR
#1024)** publishes the band Causl commits to on contract-bearing
cells: `mobx_median × 3.0 ≤ causl_median ≤ mobx_median × 8.0`. The
band decomposes as a `1.84× engine baseline × 3.5× replay-
determinism contract premium`. The current bench report
(`packages/bench/report/fair-fight-results.json`, refreshed by
`pnpm tolerant`) sits inside the band on the canonical scenarios:
`equality-cutoff × 10000` runs at roughly 1.36 ms causl vs 0.21 ms
mobx (≈6.4× — inside the band); `scrolling-viewport × 10000` runs
at roughly 5.43 ms causl vs 1.4 ms mobx (≈3.9× — inside the band,
post-perf-umbrella #679 which closed the 654× regression
flagged on PR #992).

The honest framing for adopters: a MobX → Causl migration on a
hot path that resembles the bench scenarios should expect a
mid-single-digit constant-factor slowdown. That is the contractual
price for atomic commits, replay-determinism, and the §15.2
property-test floor — not an engineering miss. If your workload
shows a regression *outside* the band, that's a signal worth
filing against `MEDIAN_BAND_INVARIANTS` in
`packages/bench/src/hypotheses/causl-hypotheses.ts`.

## What the drift detector will *not* auto-rewrite

- `@observable` class fields without explicit `runInAction` boundaries
  — the migration is fundamentally a refactor, not a rewrite.
- MobX-React's `Provider` / `inject` — those are component-level
  patterns; `causl-migration-check` flags them and the reviewer
  rewires through `<CauslProvider>` by hand. See
  `docs/migration/RULE_CATALOGUE.md` for the rule IDs.
- `when(predicate, effect)` — manual; usually expressible as a
  conditional inside `subscribe`.
