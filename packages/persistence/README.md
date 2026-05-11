# @causl/persistence

UI-preference persistence for [Causl](../../README.md). This package
persists editor-controller state — what the cursor is doing, what's
selected, column widths, filters, view preferences — the user's tools,
not the user's information model. Those identifiers live in a
controller namespace (e.g. `controller:gridSelection:wb1`) with
session-scoped lifetimes; they can be destroyed without destroying any
model fact, which is precisely what makes them safe to round-trip
through `localStorage`. **Inputs only**: a derived value at time `t` is
a pure function of its inputs at the same `t`, so writing a derived to
disk would be both redundant and a glitch-freedom hazard the moment its
formula or upstream inputs change. Derived values recompute from inputs
on rehydration; they are never on-disk-canonical.

## Install

```bash
pnpm add @causl/persistence @causl/core
```

## Quick start

```ts
import { createCausl } from '@causl/core'
import { persistedInput, localStorageAdapter } from '@causl/persistence'

const graph = createCausl()
const columnWidth = persistedInput(graph, 'colWidth', 200, {
  key: 'xldatagrid:col-width',
  storage: localStorageAdapter(),
  version: 1,
})
```

## Boundary

This package enforces a strict boundary against the information model.
Multi-user synchronisation, server-authoritative state, and any
authoritative model persistence are deliberately out of scope: those
decisions cannot be made until the single-user engine actually works,
and they belong above this layer, not inside it. What this package
will and won't do:

- Persists UI-preference state only — never authoritative information-model data.
- Refuses to wrap `graph.derived` (compile-time enforced).
- No `persistedGraph` — the boundary is enforced by API shape, not by convention.

## Status

Shipped as of v0.9.0. The three originally-planned surfaces all
landed:

- `persistedInput()` — #136.
- `StorageAdapter` + `localStorageAdapter()` + `memoryAdapter()` (the
  latter for tests and SSR) — #137.
- Schema evolution via `version` + `migrate(stored, storedVersion)`,
  with the typed `PersistenceError` discriminated union
  (`parse | migrate-threw | migrate-missing | serialise | quota`) and
  the `preserveOnError` default of `true` so failed load paths leave
  the on-disk envelope intact rather than silently destroying user
  data — #138, refined by #370 (split `migrate-threw` / `migrate-missing`
  per SPEC §17.4's no-state-machine-in-an-optional rule, also called
  out in SPEC §5.2).

The package consumes the narrow capability slice
`Pick<Graph, 'input' | 'subscribeCommits' | 'read'>` (`PersistenceGraph`)
— per SPEC §13 the persistence boundary gets only the authority its
job demands. The boot-write skip (review-209 P0) drives writes off
`subscribeCommits` filtered by `changedNodes`, so a cold start never
round-trips an unchanged envelope back to disk.

Snapshot/restore of the wider graph state (inputs + `GraphTime`) lives
on `@causl/devtools` (`exportSnapshot` / `importSnapshot`) and uses
`graph.snapshot` / `graph.hydrate` under SPEC §12.2; that surface is
intentionally separate from this package, which is UI-preference-only.

Multi-user synchronisation and authoritative model persistence remain
out of scope, per the Boundary section above.
