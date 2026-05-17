# @causl/react

> React 18+ bindings for [@causl/core](../core/).

## Install

```bash
pnpm add @causl/react @causl/core react react-dom
```

## Provider + hooks

```tsx
import { createCausl } from '@causl/core'
import {
  CauslProvider,
  createUpdate,
  defineMsgs,
  payload,
  useCausl,
  useDispatch,
  type MsgOf,
} from '@causl/react'

const graph = createCausl()
const counter = graph.input('counter', 0)

// Declare the discriminated `Msg` union once, as a record of
// `tag → payload?`. The same shape pairs with `createUpdate`'s
// record-of-handlers below.
const msg = defineMsgs({
  inc: null,
  set: payload<{ value: number }>(),
})
type Msg = MsgOf<typeof msg>

const update = createUpdate<Msg>({
  inc: (_m, g) => {
    g.commit('inc', (tx) => tx.set(counter, g.read(counter) + 1))
  },
  set: (m, g) => {
    g.commit('set', (tx) => tx.set(counter, m.value))
  },
})

function Counter() {
  const value = useCausl((g) => g.read(counter))
  const dispatch = useDispatch<Msg>()
  return <button onClick={() => dispatch(msg.inc())}>{value}</button>
}

export const App = () => (
  <CauslProvider graph={graph} update={update}>
    <Counter />
  </CauslProvider>
)
```

## Typed `Msg` helper

The §8 MVU surface is the application boundary where "make
impossible states impossible" applies — messages are the front
door, and the `Msg` discriminated union is what the type system
enforces.

- **`defineMsgs({ tag: null | payload<T>(), ... })`** — record-of-
  payloads builder returning a typed variant-constructor record. The
  same record shape pairs with `createUpdate`'s record-of-handlers,
  so tags are declared once.
- **`MsgOf<typeof builder>`** — extractor pulling the closed `Msg`
  union back out of a builder for use as the type parameter to
  `createUpdate<Msg>()` or `useDispatch<Msg>()`.
- **`Msg<K, P>`** — generic variant template for callers who prefer
  to spell the union out by hand: `Msg<'inc'> | Msg<'set', { value:
  number }>`.
- **`assertNever(value)`** — exhaustiveness probe for the `default`
  arm of a `switch (msg.kind)`. Adding a tag without a matching arm
  is a compile error at the call site, not a runtime throw.

Adding a fourth tag to the `defineMsgs` record without adding a
matching handler is a compile error at the `createUpdate` call site;
adding a fourth tag without naming it in a `switch (msg.kind)` is a
compile error at the `assertNever(msg)` default arm. Both gates fail
closed.

## Hooks

- **`useCausl(selector)`** — `(graph) => T`; re-renders on commits
  whose selector return is not `Object.is`-equal to the previous.
  Subscribes to every commit via `subscribeCommits` and deduplicates
  at the selector boundary.
- **`useCauslShallow(selector)`** — same but with a shallow
  comparison. Use this for object/array selectors that would otherwise
  return fresh references each call.
- **`useCauslNode(node)`** — per-node subscription hook (#677). Routes
  through `graph.subscribe(node, cb)` so React's `onChange` only fires
  for commits that change *this* node — unrelated commits never trigger
  a re-render. Prefer this over `useCausl` when reading a single node;
  prefer `useCausl(selector)` for multi-node projections. The e2e
  dropped-frames gate (≤ 5% over 30s on a 1000-cell viewport at 60Hz,
  p95 commit-to-paint ≤ 16ms) shipped in #765.
- **`useCauslTypedArrayNode(node, ctor)`** — typed-array projection
  hook (#688, sub-task of WASM substrate epic #680, shipped in #1055).
  Returns a `Float64Array | Uint8Array | Int32Array` view that is
  stable across renders until the next commit changes the node. See
  the *Current state* callout below.
- **`useCauslFamily(factory)`** — `atomFamily`-style per-key node
  identity within a provider, with refcount-driven disposal.
- **`useCauslSuspense(resource, selector)`** — projects a
  `SuspendableResource<T>` through a selector and either returns the
  resolved `T`, throws a Promise for `<Suspense>`, or throws an error
  for an error boundary.
- **`useDispatch<Msg>()`** — typed dispatcher running the provider's
  `update` against the provider's graph.
- **`<Hydrate snapshot={...} />`** — SSR hydration component (#130);
  applies a server-captured `GraphSnapshot` to the provider's graph on
  first mount.

## Current state — typed-array zero-copy (as of v0.9.0)

`useCauslTypedArrayNode` ships the **JS-engine fallback path** today.
The full zero-copy view-into-linear-memory implementation is wired
against the WASM substrate (epic #680, closed; Phase-0 + Phase-1
scaffolding complete). Wiring the real Rust engine through the
adapter is tracked under the post-0.9.0 Rust port epic #1133
(deferred; GO/NO-GO criteria documented in the epic body — final
sub-issue #1148 closes the React-adapter wire-up).

Until #1133 lands, the hook:

- detects the WASM backend at module load via `loadWasmBackend()`
  (#1031); the loader currently surfaces `WasmBackendUnavailableError`
  (`code: 'CAUSL_WASM_NOT_BUILT'`),
- reads the node's current committed value through the TS-wrapper
  engine (which clones via `structuredClone` at the read boundary —
  see SPEC §15.1 below),
- coerces non-matching values via `ctor.from(value)` (one-shot copy on
  commit), and
- caches the view reference per commit so `React.memo`-style identity
  skips work today.

The call site is forward-compatible: once #1133 lands, adopters keep
the same signature and start receiving real
`WebAssembly.Memory.buffer`-backed views with the same stability
guarantee.

## SPEC §15.1 — `graph.read(node)` reference identity

PR #1129 amended SPEC §15.1 to make explicit that
`graph.read(node)` does **not** contractually guarantee reference
identity across commits for object-shaped values (H1 hazard). The
TS-wrapper engine in use today applies `structuredClone` at the read
boundary to model the future Rust/WASM FFI faithfully — every
`read()` for an object value returns a fresh reference, even when the
underlying data did not change.

Practical consequences in React:

- `useCausl((g) => g.read(node))` for an object value will see
  not-`Object.is`-equal returns on every commit; use `useCauslShallow`
  (shallow comparison) or `useCauslNode(node)` (which leans on the
  engine's own per-node `Object.is` cutoff *on the wrapper output*
  rather than caller-visible identity) when this matters.
- Selectors that derive primitives from object reads (`(g) =>
  g.read(node).count`) are unaffected because primitives compare by
  value.

### Migration: memoise on `engine.stats().nodeVersion(node)` (#1242)

If your code relied on `read()` reference identity for object-shaped
values (the H1 hazard SPEC §15.1 now calls out), the supported
migration is to memoise on the engine's per-node version counter
instead. `engine.stats().nodeVersion(node)` returns a monotonically-
increasing integer that advances by exactly 1 each commit in which the
node's value changed (per the SPEC §15.1 `!Object.is` cutoff) and
stays unchanged on every other commit — a no-op write, an empty
commit, or a sibling-write that did not touch this node. Pinning a
downstream cache key to that integer gives you a stable memoisation
surface that survives the engine's per-read `structuredClone` boundary.

```tsx
import { useMemo } from 'react'
import { useCausl } from '@causl/react'
import type { Node } from '@causl/core'

function ExpensiveProjection({ node }: { node: Node<MyValue> }) {
  // `useCausl((g) => …)` returns a stable value (the selector's
  // result). Keying on `nodeVersion(node)` produces an integer that
  // changes IFF the node's value actually changed under the
  // engine's `!Object.is` cutoff.
  const version = useCausl((g) => g.stats().nodeVersion(node))
  const value = useCausl((g) => g.read(node))
  // `useMemo` recomputes only when `version` increments — i.e. only
  // when the node's underlying value actually changed. A no-op commit
  // (re-setting an input to its current value) keeps `version` the
  // same, so the memoised projection is reused.
  return useMemo(() => projectExpensively(value), [version])
}
```

The counter is cross-backend byte-identical (TS engine vs. Phase-1
WasmBackend wrapper) for the same commit sequence, so a future
migration to the Rust/WASM engine (#1133) inherits the same cache
behaviour without code changes. See SPEC §15.1 and PR #1245 for the
underlying contract.

## React 18 / 19 compatibility

All hooks are built on `useSyncExternalStore`. StrictMode
double-mount, concurrent rendering, and `act()`-wrapped updates are
covered by `test/strictMode.test.tsx`; `Hydrate` uses a
WeakMap-by-graph guard so the second mount in StrictMode's
mount/cleanup/remount cycle does not double-apply the snapshot. The
CI matrix runs the package against both React 18.3 and React 19 (see
`.github/workflows` and `peerDependencies` in `package.json`).
