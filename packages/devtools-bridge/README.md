# @causl/devtools-bridge

Bridges Causl commits to the [Redux DevTools Extension](https://github.com/reduxjs/redux-devtools)
protocol. Zero-cost when the extension is absent — `connectDevtools` short-circuits before
allocating any subscription or observer.

> **Internal / not independently published.** Per SPEC §13 this package is held private until a
> downstream UI earns its place or §13 is amended; it realises the §11 inspection primitives
> end-to-end. The public inspection surface adopters reach for is [`@causl/devtools`](../devtools/).

## Install

```sh
pnpm add @causl/devtools-bridge
```

## Use

```ts
import { createCausl } from '@causl/core'
import { connectDevtools, isExtensionAvailable } from '@causl/devtools-bridge'

const graph = createCausl()

// No-op (and allocates nothing) when the extension is not installed.
const disconnect = connectDevtools(graph, { name: 'my-app' })

// disconnect() when you tear the graph down.
```

Each `Commit` forwarded to the panel becomes a Redux action of the form
`{ type: intent, payload: { changedNodes } }` paired with a `graph.snapshot()` for state
inspection. Time-travel monitor messages (`JUMP_TO_STATE`, `IMPORT_STATE`, `ROLLBACK`) project
state via `graph.snapshotAt(t)` — a *read*, never a mutation.

## What this is NOT

- Not a standalone DevTools UI — it speaks the existing Redux DevTools Extension protocol.
- Not required at runtime — when the extension is absent it does nothing and tree-shakes cleanly.
