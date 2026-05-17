# Migrating from Redux/Redux Toolkit to Causl

Companion to `from-jotai.md` and `from-mobx.md`. The contract that
backs this guide is `docs/migration/RULE_CATALOGUE.md`; the drift
detector `causl-migration-check` (see `packages/migration-check`)
flags un-migrated patterns in CI by rule ID. There is no codemod
and we do not plan to ship one — the migration is hand-written
under the rule catalogue's guidance. The drift detector classifies
findings; it does not transform source.

## Mapping at a glance

| Redux/RTK                            | Causl                                                  | Mechanical? |
| --- | --- | --- |
| `createSlice({ initialState, reducers })` | one input per slice field + `createUpdate({ ... })`   | structural  |
| `useSelector(selector)`              | `useCausl(selector)`                                    | yes         |
| `useDispatch()` (Redux)              | `useDispatch<Msg>()` (Causl — typed)                    | yes         |
| `dispatch({ type, payload })`        | `dispatch({ kind, ...payload })`                           | yes         |
| `combineReducers({ slice1, slice2 })`| pattern-match on `Msg.kind` in `createUpdate`              | structural  |
| `createAsyncThunk`                   | `resource(graph, key, { loader })` + `useCauslSuspense` projection | manual |
| `createEntityAdapter`                | `useCauslFamily(id, factory)` per entity               | manual      |
| `configureStore({ middleware })`     | `subscribeCommits` for cross-cutting concerns              | manual      |
| Immer drafts                         | manual immutable updates                                   | manual      |

## Why `Msg.kind` and not `Msg.type`

Redux's convention is `{ type: 'slice/action', payload }`. Causl's
convention is `{ kind: 'action', ...fields }` — `kind` because
"type" is overloaded with TypeScript's word, and flat fields because
discriminated unions are simpler to exhaust over than `payload`-as-bag.
Apply the shape change by hand; the drift detector
(`causl-migration-check`) reports `payload`-shaped messages,
middleware, and async thunks by rule ID — see
`docs/migration/RULE_CATALOGUE.md`.

## Worked example

**Before (RTK):**

```ts
const counterSlice = createSlice({
  name: 'counter',
  initialState: { value: 0 },
  reducers: {
    incremented: (state) => { state.value += 1 },
    set: (state, action: PayloadAction<number>) => { state.value = action.payload },
  },
})
```

**After (Causl):**

```ts
import { createCausl } from '@causl/core'
import { createUpdate } from '@causl/react'

const graph = createCausl()
const counter = graph.input('counter', 0)

// Value-bearing messages — the payload supplies the next counter
// value rather than a delta the handler reads back from the graph.
// This honours rule `S-03` in `docs/migration/RULE_CATALOGUE.md`:
// no `g.read(...)` inside a `tx` callback. Compute the new value at
// the dispatch site (or in a derived) and pass it as the payload.
type Msg =
  | { kind: 'set'; value: number }
  | { kind: 'reset' }

const update = createUpdate<Msg>({
  set: (msg, g) => {
    g.commit('set-counter', (tx) => tx.set(counter, msg.value))
  },
  reset: (_msg, g) => {
    g.commit('reset-counter', (tx) => tx.set(counter, 0))
  },
})

// At a dispatch site that needs to "increment":
//   const current = g.read(counter)
//   dispatch({ kind: 'set', value: current + 1 })
```

> **Note on §8.** Per #377, the runner is now `Update<Msg, Graph> =
> (msg, graph) => void`. Each handler issues exactly one
> `graph.commit(...)` and returns nothing — the graph is a stable
> handle whose `now` advances per commit, so the prior `return g`
> carried no information. Rule `S-02` in the catalogue still flags
> hand-written handlers that return their `graph` argument so the
> linter remains useful when migrating older code.

## Async thunks

`createAsyncThunk` orchestrates a fetch-and-store-result lifecycle
keyed off action types. Causl splits the two concerns: the
`resource` primitive from `@causl/sync` owns the lifecycle as a
tagged-union node on the graph, and `useCauslSuspense` from
`@causl/react` projects the same node into Suspense semantics at
the React boundary. Both ship today.

```ts
import { resource } from '@causl/sync'
import { useCausl, useCauslSuspense } from '@causl/react'

// Before
const fetchUser = createAsyncThunk('user/fetch', async (id: string) => {
  return await api.getUser(id)
})

// After
const userResource = resource<User>(graph, 'user', {
  loader: () => api.getUser(currentUserId),
})
// Trigger from a dispatch site or effect:  await userResource.fetch()

// Suspense-style read — throws on `loading`, the nearest error
// boundary catches `errored`, `stale` returns the cached value.
function UserViewSuspense() {
  const u = useCauslSuspense((g) => g.read(userResource.node))
  return <h1>{u.name}</h1>
}

// Inline-state read — render loading and error states without
// escalating to Suspense.
function UserView() {
  const state = useCausl((g) => g.read(userResource.node))
  if (state.kind === 'loading') return <Spinner />
  if (state.kind === 'errored') return <ErrorView e={state.error} />
  return <h1>{state.value.name}</h1>
}
```

## Current state (as of v0.9.0): `read()` and reference identity

Redux's `useSelector` uses `Object.is` to gate re-renders: if the
selector returns the same reference as last call, React skips
re-render. Idiomatic RTK code with `createSelector` (reselect)
caches the projected object so identity is preserved across calls
when inputs are unchanged. Causl's `useCausl((g) => g.read(node))`
*today* gives you the same behaviour on the JS engine — but per
the **SPEC §15.1 amendment (#1124)**, reference identity across
calls is **not** contractually guaranteed. Today's `WasmBackend`
is a TS-engine wrapper, so an object-valued `read()` returns the
same reference trivially; the day the real Rust `serde`/`wasmgc`
bridges land per §17.6, `read()` will return a fresh object per
call as the value is deserialised across the FFI boundary.
Adopters who depend on identity for memoisation (selector-return
identity feeding `React.memo`, `useMemo` keyed on a slice) will
silently re-render every commit once they `migrate('wasm')`.

The contractual identity surface is **value identity**:
`Object.is(read(node)@t, read(node)@t)` holds for two synchronous
reads at the same `GraphTime`; cross-commit identity is
backend-dependent. If you carry an RTK pattern that keys memoisation
off a selector's object return, port the key to the per-commit
`GraphTime` (read via `useCausl((g) => g.now)`) or the per-node
version counter `EngineTelemetry` surfaces. Cross-link:
`docs/wasm-adoption-guide.md` H1.

## Entity adapters

`createEntityAdapter`'s normalized `{ ids, entities }` map maps
naturally to `useCauslFamily(key, factory)` — the family hook gives
you a stable `Node<T>` per entity id within a provider, with refcount-
driven disposal when the last consumer unmounts. This shipped in
PR #209 and is exported from `@causl/react`.

```ts
// Before
const usersAdapter = createEntityAdapter<User>()

// After
function UserRow({ id }: { id: string }) {
  const node = useCauslFamily(`user:${id}`, (graph, key) =>
    graph.input(key, defaultUser),
  )
  const user = useCausl((g) => g.read(node))
  return <tr>{user.name}</tr>
}
```

## What the drift detector will *not* auto-rewrite

- Middleware (logger, thunk, saga). Most middlewares have a
  Causl equivalent via `subscribeCommits`, but the migration is
  case-by-case.
- `createSelector` (reselect). Causl's derived nodes already
  memoize by identity, so the wrapper is usually unnecessary;
  `causl-migration-check` flags occurrences by rule ID — see
  `docs/migration/RULE_CATALOGUE.md` (rule `R-05`).
- Redux DevTools — replaced wholesale by `@causl/devtools-bridge`
  (#142), which speaks the same protocol.
