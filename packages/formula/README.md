# @causljs/formula

> Spreadsheet-style formula primitives layered on
> [@causljs/core](../core/). The core engine knows nothing about `=A1+B1`;
> this package translates AST → derived node.

## Install

```bash
pnpm add @causljs/formula @causljs/core
```

## Quick start

```ts
import { createCausl } from '@causljs/core'
import {
  cellId,
  createFormulaAdapter,
  parseFormula,
  valueOr,
} from '@causljs/formula'

const graph = createCausl()
const a1 = graph.input(cellId('wb', 'Sheet1', { col: 0, row: 0 }), 5)
const b1 = graph.input(cellId('wb', 'Sheet1', { col: 1, row: 0 }), 10)

const adapter = createFormulaAdapter(graph, {
  workbook: 'wb',
  sheet: 'Sheet1',
  resolve: (ref) => {
    if (ref.col === 0 && ref.row === 0) return a1
    if (ref.col === 1 && ref.row === 0) return b1
    return undefined
  },
})

const c1 = adapter.registerFormula(
  { col: 2, row: 0 },
  parseFormula('=A1+B1'),
)
console.log(graph.read(c1))                  // { kind: 'value', value: 15 }
console.log(valueOr(graph.read(c1), 0))      // 15
```

## Error states

Make impossible states impossible: rather than four optional fields
where "has a value AND an error" is representable, evaluation resolves
to a discriminated union. Divide-by-zero, non-numeric coercion,
unresolved refs, unknown functions, AVG/MIN/MAX of empty sets, and
upstream propagation all become `{kind: 'error', error: {kind, message,
ref?}}` rather than throwing or silently zeroing. The tag is the gate;
a compile-time check stands between a caller and the value.

```ts
const broken = adapter.registerFormula({col: 3, row: 0}, parseFormula('=A1/0'))
const r = graph.read(broken)
// { kind: 'error', error: { kind: 'div-by-zero', message: 'Division by zero' } }
```

## Built-in functions

`SUM`, `AVG` / `AVERAGE`, `MIN`, `MAX`. Operate on cell ranges
(`A1:A10`) or scalar lists (`SUM(A1, B2, 5)`).

## Cycle detection

```ts
import {
  emptyFormulaGraph,
  addFormula,
  detectCycle,
  parseFormula,
} from '@causljs/formula'

const g = emptyFormulaGraph()
addFormula(g, { col: 0, row: 0 }, parseFormula('=B1'))
addFormula(g, { col: 1, row: 0 }, parseFormula('=A1'))
detectCycle(g) // ['A1', 'B1', 'A1']
```

The engine *also* catches cycles at first-commit time (`CycleError`).
This module is the pre-flight detector that lets the host application
reject formulas before they hit the engine.

## Runnable demo

A 100-cell spreadsheet diamond demo lives under `demo/` and exercises
the same wiring this README describes against `@causljs/core` and
`@causljs/devtools`. From the repo root:

```bash
pnpm --filter @causljs/formula run demo
```

The demo builds the three packages and serves `demo/index.html` on a
local port. It is the runnable companion to the SPEC §11 "the engine
is its own observer" claim — every grid cell, the commit-log panel,
and the "why did this update?" line subscribe through the same public
engine surface tests use.

## 0.1.0 surface change

`0.1.0` was a surface-breaking pre-1.0 minor (issue #1081, follow-up
to the IR carve in #1075 / original #697); both PRs landed pre-0.9.0
and the surface below is the current one. Two changes:

1. **`parseFormula` consumes IR types directly.** `parseFormula` and
   the cycle helpers now import `Ast`, `BinOp`, and `CellRef` from the
   internal IR module instead of `./grammar.js`. The `@causljs/formula`
   package barrel re-exports the same types, so the public type
   identity is unchanged for adopters that import from the package
   root. Adopters who imported types from the deep path
   `@causljs/formula/grammar` will see a moved-source identity.

2. **`FormulaHost` interface + public `evaluate(ast, host)`.** The
   evaluator no longer takes a `(resolve, get)` closure pair. It now
   consumes a `FormulaHost`:

   ```ts
   interface FormulaHost {
     readNumber(cellId: string): number | FormulaError
   }
   evaluate(ast: Ast, host: FormulaHost): FormulaResult
   ```

   `cellId` is the A1 reference string. The host owns coercion *and*
   upstream propagation: a cell whose backing value is itself an
   errored `FormulaResult` must be returned as a `propagated`
   `FormulaError`, so the evaluator can forward host errors as-is. A
   Rust evaluator port that satisfies the same contract is the long-
   term plan; the wire-IR mirror in `tools/engine-rs-core/src/formula_ir.rs`
   (feature-gated `future`, landed via #1078 / #1080) is the seam, but
   the actual evaluator port is deferred to post-0.9.0 epic #1133 with
   the GO/NO-GO criteria documented in the epic body.

   `createFormulaAdapter` is unchanged — it now constructs a
   `FormulaHost` internally from the existing `resolve` + the engine's
   read hook. Direct adopters of the previous internal `evaluate(ast,
   resolve, get)` form (none in-tree) must migrate to the new entry.
