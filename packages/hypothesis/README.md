# @causl/hypothesis

Temporal-logic hypothesis combinators for the Causl bounded enumerator (SPEC §16.5).

A small combinator library for expressing temporal properties (`always`, `eventually`, `until`,
`implies`, …) over the enumerator's bounded state-space traces, plus shrinkers for minimising
counterexamples and a `pairWithApalacheModel` helper that tags hypotheses for cross-checking
against the Apalache TLA+ differential corpus.

> **hypothesis vs `tools/apalache-diff/`.** These are two halves of one differential surface, not
> the same thing. This package is the **authoring/evaluation** layer — it builds hypothesis
> combinators, evaluates them against enumerator traces (`evaluate`), and tags them for pairing
> (`pairWithApalacheModel` / `collectPairings`). The runner under
> [`tools/apalache-diff/`](../../tools/apalache-diff/) is the **execution harness** that takes
> those tagged pairings and cross-checks the enumerator's verdicts against Apalache TLA+
> counterexamples on the EPIC-7 corpus.

## Install

```sh
pnpm add @causl/hypothesis
```

## Use

```ts
import { hypothesis, always, eventually, implies, evaluate } from '@causl/hypothesis'

// "Whenever a commit raises a conflict, the conflict is eventually cleared."
const h = hypothesis(
  'conflict-eventually-cleared',
  always(implies(
    (s) => s.hasConflict,
    eventually((s) => !s.hasConflict),
  )),
)

const result = evaluate(h, trace) // EvaluateResult — holds | counterexample
```

Combinators: `always`, `eventually`, `never`, `until`, `during`, `and`, `or`, `implies`,
`afterCommit`, `atStart`, `holds`, `fromPredicate`. Shrinkers: `shrink`, `shrinkPrefix`,
`shrinkStepCount`, `shrinkStatePayload`, `shrinkActionArity`.

## What this is NOT

- Not a runtime assertion library — it operates over enumerator traces, not a live `Graph`.
- Not the Apalache runner itself — see `tools/apalache-diff/` (above).
