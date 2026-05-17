# SPEC §11 spreadsheet demo

> The engine is its own observer.

SPEC §11 commits to a load-bearing claim:

> If I cannot demo "edit a derivation while it's running, watch the change propagate," I have not earned the comparison to spreadsheets.

`pnpm demo:spreadsheet` runs that demo locally. It builds `@causljs/core`, `@causljs/devtools`, and `@causljs/formula`, then serves a static page (`packages/formula/demo/index.html`) on `http://127.0.0.1:4173`.

The page wires the same 100-cell diamond the Phase 3 acceptance suite already exercises (`packages/formula/test/spreadsheetDemo.test.ts`):

- Column A: ten plain `graph.input`s a user can edit by typing into the cells.
- Columns B–D: `=A*2`, `=B+1`, `=C*B` — registered through `liveDerived` so a developer can rewrite their formulas without restarting.
- Cell E1: `=SUM(D1:D10)`, also a live derivation.

## Running it

```sh
pnpm install
pnpm demo:spreadsheet
```

The first build takes a few seconds; subsequent runs reuse `dist/`. Open the printed URL.

## What to watch for

### 1. Edit a derivation while it's running

In the page:

1. Pick a cell from the dropdown (`E1`, `D1`, `D2`, or `D3`).
2. Edit the formula in the textarea — try `=AVG(D1:D10)`, `=MAX(D1:D10)`, `=A1*100`, `=SUM(B1:B10)`.
3. Click **Apply** (or press ⌘/Ctrl-Enter).

The selected cell flashes; every downstream cell that depends on it re-renders inside the same commit. The change propagates through the same primitives the engine offers every other consumer: `replaceMany` swaps the closure, the engine bumps the hidden version input, the recompute fires once, and downstream subscribers see exactly one notification.

In the console:

```js
demo.edit('E1', '=AVG(D1:D10)')   // returns the new value
demo.edit('D5', '=A5 * 1000')     // watch row 5 (and E1) update
```

### 2. See propagation through the commit log

The "Commit log" panel renders the most recent entries from `commitLog(graph)` — a `DerivedNode<readonly Commit[]>` projection of `graph.commitLog`, capped to a configurable capacity and reversed to most-recent-first for UI consumption. Every cell mutation, every formula edit, lands as a single entry showing the intent string, monotonic graph time, and the set of `changedNodes`.

### 3. Ask the engine why a cell updated

The "Why did this update?" panel reads `whyUpdated(graph, node)` for the selected cell — itself a `DerivedNode<WhyResult>` that recomputes on every commit. It tells the developer one of:

- `directly-set` — a `tx.set` inside the latest commit touched this node.
- `recomputed` — a dependency changed and the closure was re-run.
- `no-cause` — the visible commit window contains nothing that touched this node.

Each classification is rooted in the engine's own primitives (`graph.explain` and the `Commit.changedNodes` array on the log entry) — there is no parallel devtools state.

## Console handles

`window.demo` exposes:

| Field | What it is |
| --- | --- |
| `graph` | The live `Graph` instance. |
| `replaceMany` | Re-exported from `@causljs/devtools`. |
| `commitLog` | Live `DerivedNode<readonly Commit[]>` projection, capacity 50. |
| `whyUpdated(name)` | Shorthand against the live cell named `name`. |
| `cells` | Map of cell name → live derivation handle + current formula text. |
| `inputs` | The ten column-A `InputNode`s. |
| `edit(name, formula)` | Re-parse and replace in one commit; returns the new value. |
| `parseFormula`, `cellRefToA1`, `a1ToCellRef` | Re-exported helpers. |

## Why I built it this way

The previous spec described a careful database with React bindings, but the thing that made spreadsheets matter — that a non-programmer can change a formula in a cell and see the world recompute now — went unstated. I refuse to fix that with a "devtools panel" sitting next to the engine. The grid renders by subscribing to each cell's node. The commit-log panel renders by subscribing to a derived view of `graph.commitLog`. The "why?" line uses `whyUpdated` against that same log. Every observation a developer wants is a read or subscribe through the public engine surface.

That is what §11 means by "the engine is its own observer."

## Deployed playground

This demo is the local-developer-runnable form of §11's claim. The deployed playground (linkable from anywhere, no `pnpm install` required) lives as a static React page under [`causl-org/spreadsheet/`](../causl-org/spreadsheet/index.html) — see the README's "Try it live" section.
