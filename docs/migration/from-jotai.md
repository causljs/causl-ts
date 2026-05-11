# Migrating from Jotai to Causl

This guide is the source of truth for what changes when a Jotai
codebase moves to Causl. It is written for humans (and their
LLM assistants) doing the migration by hand — every pattern below
has a worked example and a rationale.

I deliberately do **not** ship a codemod. The contract that backs
this guide is `docs/migration/RULE_CATALOGUE.md`, and the drift
detector `causl-migration-check` (see `packages/migration-check`)
flags un-migrated patterns in CI by rule ID. If you want machine
help, run the drift tool — it tells you which rule each finding
maps to so you can come back here and apply the worked example by
hand. The drift detector classifies, it does not transform.

## Mapping at a glance

| Jotai                              | Causl                                                     | Mechanical? |
| --- | --- | --- |
| `atom(initial)`                    | `graph.input(id, initial)`                                   | yes         |
| `atom((get) => …)`                 | `graph.derived(id, (get) => …)`                              | yes         |
| `atomFamily(id => atom(…))`        | `useCauslFamily(key, (g, k) => g.input(...))`             | structural  |
| `atomWithStorage(key, initial)`    | `persistedInput(graph, id, initial, opts)` — see [Persistence](#persistence) | structural  |
| `atomWithReducer(initial, reducer)`| `graph.input` + `useDispatch` + `createUpdate({ ... })`      | manual      |
| `atomWithObservable(observable)`   | `resource(graph, key, { loader: () => fromObservable(...) })`| manual      |
| Async `atom(async (get) => …)`     | `useCauslSuspense(selector)` — see [Suspense](#suspense)  | manual      |
| `useAtom(atom)`                    | `[useCausl(...), useDispatch<...>()]`                     | yes         |
| `useAtomValue(atom)`               | `useCausl((g) => g.read(node))`                           | yes         |
| `useSetAtom(atom)`                 | `useDispatch<MyMsg>()` returning a typed dispatcher          | yes         |

The "yes" rows are mechanical (search-and-replace within a worked
example). The "structural" rows require user judgment about
identifiers and lifecycle. The "manual" rows need a rewrite. The
drift detector (`causl-migration-check`, see
`packages/migration-check`) flags any of these patterns surviving
in CI; see `docs/migration/RULE_CATALOGUE.md` for the rule IDs.

## Worked example: a counter

**Before (Jotai):**

```ts
import { atom, useAtom } from 'jotai'

const counterAtom = atom(0)
const doubledAtom = atom((get) => get(counterAtom) * 2)

function Counter() {
  const [counter, setCounter] = useAtom(counterAtom)
  const [doubled] = useAtom(doubledAtom)
  return (
    <button onClick={() => setCounter(counter + 1)}>
      {counter} (×2 = {doubled})
    </button>
  )
}
```

**After (Causl):**

```ts
import { createCausl } from '@causl/core'
import {
  createUpdate,
  CauslProvider,
  useDispatch,
  useCausl,
} from '@causl/react'

const graph = createCausl()
const counter = graph.input('counter', 0)
const doubled = graph.derived('doubled', (get) => get(counter) * 2)

// Messages are value-bearing: the payload is the next counter value.
// This is the idiomatic shape for SPEC §5 — `tx.set` is the write
// primitive, and the value it stages is supplied by the caller, not
// recomputed by reading inside the commit. See rule `S-03` in
// `docs/migration/RULE_CATALOGUE.md`.
type Msg = { kind: 'set'; value: number }

const update = createUpdate<Msg>({
  set: (msg, g) => {
    g.commit('set-counter', (tx) => tx.set(counter, msg.value))
  },
})

function Counter() {
  const counterValue = useCausl((g) => g.read(counter))
  const doubledValue = useCausl((g) => g.read(doubled))
  const dispatch = useDispatch<Msg>()
  return (
    <button
      onClick={() => dispatch({ kind: 'set', value: counterValue + 1 })}
    >
      {counterValue} (×2 = {doubledValue})
    </button>
  )
}

export const App = () => (
  <CauslProvider graph={graph} update={update}>
    <Counter />
  </CauslProvider>
)
```

Why the extra ceremony? Causl's atomic-commit model means a "set"
is a Msg → commit, not a setter call. This is more code; in return
every commit is replayable, every value is glitch-free, and every
write has an `intent` string the DevTools bridge picks up.

> **Note on §8.** Per #377, the runner is now `Update<Msg, Graph> =
> (msg, graph) => void`. Each handler issues exactly one
> `graph.commit(...)` and returns nothing — the graph is a stable
> handle whose `now` advances per commit, so the prior `return g`
> carried no information. Rule `S-02` in the catalogue still flags
> hand-written handlers that return their `graph` argument so the
> linter remains useful when migrating older code.

## Current state (as of v0.9.0): `read()` and reference identity

Jotai's `useAtomValue` returns the atom's current value; on the JS
runtime that value is a stable JS reference until the atom changes,
and downstream `useMemo([value])` / `React.memo` work as the
adopter expects. Causl's `useCausl((g) => g.read(node))` *today*
gives you the same behaviour — but per the **SPEC §15.1 amendment
(#1124)**, reference identity across calls is **not** contractually
guaranteed. Today's `WasmBackend` is a TS-engine wrapper, so an
object-valued `read()` returns the same reference trivially; the
day the real Rust `serde`/`wasmgc` bridges land per §17.6, `read()`
will return a fresh object per call as the value is deserialised
across the FFI boundary. Adopters who depend on identity for
memoisation will silently re-render every commit once they
`migrate('wasm')`.

If your migrating Jotai code keys `useMemo` / `React.memo` off a
`useAtomValue` return, port it to key off the per-commit
`GraphTime` (read via `useCausl((g) => g.now)`) or the per-node
version counter `EngineTelemetry` surfaces — not the read return
reference. Contractual identity is **value identity**:
`Object.is(read(node)@t, read(node)@t)` holds for two synchronous
reads at the same `GraphTime`; cross-commit identity is
backend-dependent. Cross-link: `docs/wasm-adoption-guide.md` H1.

## What this guide will *not* coalesce automatically

Multiple sequential `setX(); setY()` in Jotai is N atom writes — but
the *intent* of "set X then set Y" is often "I want both to happen at
once." Causl's `commit(intent, tx => { tx.set(X); tx.set(Y) })` is
the literal atomic version. The drift detector
(`causl-migration-check`) flags every `set; set` pair surviving
the migration with the corresponding rule ID from
`docs/migration/RULE_CATALOGUE.md` (rule `S-01`):

```ts
// causl-migration-check: consider single commit (S-01)
dispatch({ kind: 'set-x', value: ... })
dispatch({ kind: 'set-y', value: ... })
```

Reviewer collapses if appropriate by hand — the detector classifies,
it does not rewrite.

## Suspense

Jotai's `atom(async (get) => …)` throws a Promise. Causl's
`@causl/sync` `resource(...)` is a tagged-union; the projection
through `useCauslSuspense(selector)` re-introduces the
throw-Promise behaviour at the React boundary. Both primitives ship
today: `resource` from `@causl/sync` and `useCauslSuspense`
from `@causl/react`.

```ts
import { resource } from '@causl/sync'
import { useCauslSuspense } from '@causl/react'

// Before
const userAtom = atom(async (get) => fetch('/api/me').then(r => r.json()))
function Greeting() { const u = useAtomValue(userAtom); return <h1>{u.name}</h1> }

// After
const user = resource<User>(graph, 'me', {
  loader: () => fetch('/api/me').then((r) => r.json()),
})
function Greeting() {
  // Suspense throws on `loading`, the nearest error boundary catches
  // `errored`, `stale` returns the cached value while a refetch runs.
  const u = useCauslSuspense((g) => g.read(user.node))
  return <h1>{u.name}</h1>
}
```

If a particular call site needs to render its own loading and error
states inline rather than escalate to Suspense, read the tagged-union
state directly with `useCausl`:

```ts
function Greeting() {
  const state = useCausl((g) => g.read(user.node))
  if (state.kind === 'loading') return <Spinner />
  if (state.kind === 'errored') return <ErrorView e={state.error} />
  return <h1>{state.value.name}</h1>
}
```

## Persistence

Jotai's `atomWithStorage(key, initial)` reads from `localStorage` (or
a custom store) on mount and writes through on every set.
`persistedInput(graph, id, initial, { key, storage, version })` from
`@causl/persistence` is the Causl equivalent — same identity
contract, but the read / write hooks live on the graph rather than
the React tree, and the on-disk envelope is a versioned
`{ version, value }` record so schema evolution has a `migrate`
seam.

```ts
import { persistedInput, localStorageAdapter } from '@causl/persistence'

// Before
const themeAtom = atomWithStorage('theme', 'light')

// After
const theme = persistedInput(graph, 'theme', 'light', {
  key: 'theme',
  storage: localStorageAdapter(),
  version: 1,
})
```

`@causl/persistence` ships `localStorageAdapter()` and
`memoryAdapter()` out of the box; any object satisfying the
`StorageAdapter` interface (sync `get` / `set` / `remove`) plugs in.
Schema evolution is handled by passing a `migrate(prev, prevVersion)`
option; failures surface through the typed `PersistenceError`
discriminated union via the `onError` callback rather than throwing
into the host application.

## SSR

Jotai uses `getDefaultStore()` per-request. Causl captures
server state via `graph.snapshot()` and replays it on the client
through `<Hydrate snapshot={…}>` from `@causl/react`. The
hydration runs in a `useLayoutEffect`, so render bodies stay pure
and the server HTML and the first client paint observe identical
values.

```ts
// app/page.tsx (Next.js App Router server component)
import { createCausl } from '@causl/core'
import { Hydrate, CauslProvider } from '@causl/react'

const serverGraph = createCausl()
bootGraphFromDb(serverGraph)
const snapshot = serverGraph.snapshot()

export default function Page({ clientGraph }: { clientGraph: Graph }) {
  return (
    <CauslProvider graph={clientGraph}>
      <Hydrate snapshot={snapshot}>
        <App />
      </Hydrate>
    </CauslProvider>
  )
}
```

`graph.hydrate(snapshot)` is the imperative form for non-React hosts;
the React component wraps it with a StrictMode-safe registry that
emits exactly one `Commit { intent: 'hydrate' }` per provider mount.

## Family lifecycle

Jotai's `atomFamily(id => atom(…))` returns a memoized atom factory.
Causl's `useCauslFamily(key, factory)` is a hook with explicit
mount-driven lifecycle: when the last consumer unmounts, the node is
disposed. This shipped via PR #209 and is exported from
`@causl/react`.

```ts
// Before
const rowAtom = atomFamily((rowId: string) => atom(defaultRow))
function Row({ id }: { id: string }) {
  const value = useAtomValue(rowAtom(id))
  return <tr>{value.cells.map(...)}</tr>
}

// After
function Row({ id }: { id: string }) {
  const node = useCauslFamily(`row:${id}`, (graph, key) =>
    graph.input(key, defaultRow),
  )
  const value = useCausl((g) => g.read(node))
  return <tr>{value.cells.map(...)}</tr>
}
```

## What's deferred

- A bidirectional bridge package (`@causl/jotai-bridge`) was
  considered (#122 original phrasing). The current direction is
  guide-driven hand migration without a runtime bridge: the bridge
  encourages indefinite parallel maintenance and never gets removed.
- The drift detector (`packages/migration-check`, binary
  `causl-migration-check`) parses sources to find unmigrated
  patterns and reports them in CI by rule ID; see
  `docs/migration/RULE_CATALOGUE.md` for the rule contract. The
  detector does not transform — it classifies findings against the
  catalogue and exits non-zero on `critical` rules.
