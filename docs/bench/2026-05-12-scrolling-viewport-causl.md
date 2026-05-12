# scrolling-viewport: why causl wins (and what we should worry about)

Date: 2026-05-12
Scope: `scrolling-viewport` × 10k, causl vs redux-toolkit
Sources:
- `packages/bench/src/scenario.ts` (canonical scenario definition, line 209)
- `packages/bench/src/libraries/causl.ts` (line 278 — causl harness)
- `packages/bench/src/libraries/redux.ts` (line 384 — redux harness)
- `packages/bench/src/profile/cells/causl-scrolling-viewport-10k.ts` (CPU-profile cell)
- `packages/core/src/graph.ts` — `tx.set` fast path (line 3866), `subscribe` (4981), `phaseG_dispatchPerNodeSubscribers` (3653)

## 1. The headline

At 10 000 scale causl's median wall-time is roughly **407× lower than
redux-toolkit's** and stays around **0.08 ms** across scale=100 → scale=10 000,
i.e. the median is essentially scale-invariant. That observation is real, but
once you read what the scenario actually executes against the engine, the
**multiplier is mostly a property of the scenario, not the engine**.

## 2. What the scenario actually does

Both harnesses build `scale` cells and subscribe **one observer per cell**, then
each `step()` issues `Math.max(1, floor(scale/100))` writes per step:

| scale  | cells/subs | stride | writes per `step()` |
| ------ | ---------- | ------ | ------------------- |
| 100    | 100        | 1      | 100                 |
| 1 000  | 1 000      | 10     | 100                 |
| 10 000 | 10 000     | 100    | 100                 |

So *the per-step write count is fixed at ~100 regardless of scale*. The
**number of subscribers fired is also ~100 per step** (the per-node index in
Phase G only walks buckets keyed by the changed inputs — see graph.ts:3679).
Cell creation and the synchronous initial subscribe-fire are amortised over
`bench.iterations`; the steady-state median does not see them.

That is the entire reason causl's median is scale-invariant: **the engine's
hot path in steady-state is O(writes-per-step) = O(100), independent of
scale**. The 10 000 dimension shows up only as retained heap (10 000
`InputEntry` + 10 000 `SubscriptionEntry` + the `subscriptionsByNode` index),
not as hot-path work.

## 3. Why causl wins by ~407× vs redux

The causl per-commit envelope on this workload is essentially three things:

1. **`tx.set` hits the `hasDependents` fast path** (graph.ts:3910). Every
   input in this scenario is observed by a subscriber but has **no derived
   consumer** — `hasDependents` is `false`. The slow-path `staged` Map +
   `stagedEntries` push is skipped; the value is written directly into the
   `InputEntry` cell with an in-place rollback row.
2. **Phase D is empty.** No derived nodes, so `recomputeAffected` short-
   circuits on the empty-derivation fast path (#704, #717). No topological
   walk, no read-set bookkeeping, no equality-cutoff machinery.
3. **Phase G dispatch is index-driven** (graph.ts:3653). `subscriptionsByNode`
   gives O(1) lookup of the bucket for the one changed input per commit; that
   bucket contains exactly one entry; the observer fires; done.

So each commit is roughly: one `tx.set` fast-path write + one
`commitLogEntry` append + one Phase G bucket lookup + one observer call.
At ~100 commits per step that's microseconds of actual engine work; the
median sits at ~0.08 ms because that's the floor of the timer + V8 noise,
not the floor of the engine.

Redux-toolkit's harness, by contrast, dispatches one action per write through
Immer (`state[index] = value` inside an `Immer` producer) and notifies its
**single global subscriber** on every dispatch (redux.ts:397). Immer's
copy-on-write proxy allocation per dispatch is the cost. At 10k scale the
`initialState` array is 10 000 numbers; the Immer producer still proxies
the whole root each dispatch even though only one index changes. **Redux
pays scale-proportional cost in its reducer, not because its store model
requires it but because the harness uses Immer's array shape.** That is
the bulk of the 407× factor.

## 4. Is the win genuine or a measurement artifact?

**Mostly a scenario artifact.** Three reasons:

- **The engine's hot path is barely exercised.** No derived nodes means
  Phases C/D/E are all cold. No multi-write commit means the `staged`
  parallel arrays + `lastStagedAt` sentinel logic (#995, #972) is never
  touched. No equality-cutoff at the subscriber boundary (each write is
  `i`, distinct). The scenario measures `tx.set` fast-path + Phase G index
  lookup, which is the cheapest path the engine has.
- **`hasDependents` is false for every input**, so the most expensive
  branch of `tx.set` (staging into `stagedWriteEntries`/`stagedWriteValues`,
  the slow-path read shadow, the staged-Map allocation lifecycle) is
  *unreachable* on this scenario. The #842 hypothesis catalogue (referenced
  in `packages/bench/src/profile/diff/causl-vs-mobx-scrolling-viewport.ts`)
  notes that historically Phase G's `anyInputSubscriberIn` predicate was
  the cost centre; that's gone post the per-node-index work, leaving very
  little to amortise.
- **Redux's comparison number is a known-pessimal harness shape.** Immer
  proxying a 10k-element array root for a single-index write is the *worst*
  way to model a viewport list in redux. RTK has `createEntityAdapter`
  precisely to avoid this; the harness deliberately uses the naïve shape
  because the scenario is canonical-fair across libraries, but it does
  mean the 407× is partly "causl engine vs redux harness", not "causl
  engine vs redux fundamentals".

So: the win is real (causl really does run this workload in ~0.08 ms median
and the others don't), and the *scale-invariance* is genuinely an
architectural property (per-node-index dispatch + empty-derivation fast
path). But the **407× multiplier is partly a benchmark composition artifact**
and should not be used as a headline number without the caveat that the
hot engine paths (`tx.set` slow path, Phase D recompute, equality cutoff
on derived) are not exercised here.

## 5. What makes causl scale-invariant on this cell

The architectural choices that produce scale-invariance:

- **Per-node subscriber index** (`subscriptionsByNode`, graph.ts:1238 +
  3679). Phase G iterates the *changed set*, not the *subscriber set*. With
  one write per commit and stride-bounded writes per step, dispatch is
  O(writes) regardless of how many subscribers exist.
- **Empty-derivation fast path** (#704, #717). With zero derived nodes the
  Phase D / Phase F.5 recompute walks never enter their inner loops.
- **`InputEntry.hasDependents` fast path** (#994, graph.ts:3910). Isolated
  inputs (no derived consumers) bypass the `staged` Map entirely and write
  through the cell with a parallel-arrays rollback row.
- **Lazy `firedManyGroups` set in Phase G** (#980, graph.ts:3678). Plain
  `subscribe` never mints the dedupe Set; per-commit allocations on this
  scenario are essentially zero.

Together those four reduce the steady-state per-commit cost to a handful
of field writes + one Map.get + one observer call — work that does not
grow with scale because the scenario's stride formula keeps writes-per-step
constant.

## 6. Recommendations

The goal is to make the win **durable** (won't silently regress) and
**explicable** (the headline number tracks something we believe in).

1. **Lock the scale-invariance with a regression gate** that asserts the
   ratio `median(scale=10_000) / median(scale=100) < 1.5×` for
   `causl × scrolling-viewport`. Today the bench gate compares causl-to-
   causl across runs; adding a within-run cross-scale ratio assertion
   directly encodes the architectural claim. Wire it into
   `regression-gate.ts` next to the existing per-cell-timeout gate.

2. **Split the cell into two named scenarios** so the headline number
   stops conflating two claims. Keep `scrolling-viewport` for the
   subscriber-dispatch claim (what the canonical cell measures today),
   and add `scrolling-viewport-derived` that introduces one derived per
   visible window (e.g. a `derived` that reads 10 adjacent cells, one per
   scroll position). The derived variant exercises `hasDependents=true`,
   Phase D recompute, and the staged-Map slow path — the engine paths the
   current cell silently skips. The 407× number should hold on
   `scrolling-viewport`; the derived variant is where adopter-shape
   regressions would show up first.

3. **Capture a CPU profile per release and diff it against the previous
   release's profile** for `causl × scrolling-viewport × 10_000` (the
   profile-cell at `packages/bench/src/profile/cells/causl-scrolling-viewport-10k.ts`
   already produces the input). A frame-by-frame ratio chart in the
   release notes prevents a silent regression in the `hasDependents` fast
   path or the per-node-index dispatch from leaking out — both are exactly
   the kind of change a refactor could regress without moving the median
   above the gate's noise floor.

4. **Cite the 407× headline with the harness disclosure** ("redux harness
   uses Immer over a flat array; RTK `createEntityAdapter` is the
   adopter-recommended shape for this workload"). The disclosure already
   exists in `docs/bench-fairness.md` for other scenarios; the scrolling-
   viewport entry should explicitly note that the multiplier is a function
   of redux's reducer shape, not redux's store model, and link to the RTK
   entity-adapter comparison as a follow-on cell.

5. **Add a `scrolling-viewport-many` variant** that uses `subscribeMany`
   to register a single observer over the full cell tuple (instead of N
   independent `subscribe` calls). This exercises the `ManyGroup`
   dedupe path (graph.ts:3690) and the lazy `firedManyGroups` Set
   allocation, both of which the current cell never reaches. A delta
   between `scrolling-viewport` and `scrolling-viewport-many` at the
   same scale is the cleanest available measurement of the
   `subscribeMany` dispatch overhead — a number adopters with windowed
   list components actually pay.
