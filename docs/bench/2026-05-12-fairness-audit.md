# Bench fairness audit — `linear-chain` + `scrolling-viewport`

Date: 2026-05-12
Scope: cross-library harness shape for the two scenarios most cited in
the public comparison table. Source files audited:

- `packages/bench/src/libraries/causl.ts` (setup, lines 186-209 / 278-298)
- `packages/bench/src/libraries/jotai.ts` (setup, lines 125-171 / 236-257)
- `packages/bench/src/libraries/mobx.ts` (setup, lines 144-191 / 256-287)
- `packages/bench/src/libraries/redux.ts` (setup, lines 183-270 / 384-413)

Companion gates referenced:

- `packages/bench/test/fair-fight-parity.test.ts` (#678 boundary-count regime).
- `packages/bench/test/conformance/recompute-count-parity.test.ts` (#873).
- `packages/bench/test/conformance/cutoff-input-invariant.test.ts` (#873).
- `packages/bench/test/conformance/setup-time-parity.test.ts` (#873 FLAG-only).

## Status of #699 ("equality-cutoff and scrolling-viewport are NOT like-for-like")

Resolved by **#678** (fair-fight harness refactor). Pre-#678 the mobx
`scrolling-viewport` harness wrapped the entire scroll loop in **one**
`runInAction`, making its "4 ms" cell a single-batch coalescing artifact
while causl/jotai/redux paid per-step. Post-#678 every library iterates
`for (let i = 0; i < scale; i += stride)` and pays one boundary per
step. The `fair-fight-parity.test.ts` spec table pins
`scrolling-viewport` as the **per-step** regime with `expectedBoundaries
{ causl: 100, jotai: 100, redux: 100, mobx: 100 }` at scale=100. The
specific bug #699 flagged is gone and a structural gate prevents
regression.

A **separate** apples-to-oranges class (#873) targeted `linear-chain`
and `equality-cutoff` workload shape inside the boundary. Redux was
rewritten from a single Immer reducer loop to a chained `createSelector`
graph mirroring jotai/mobx; the `recompute-count-parity` invariant
asserts every library reports `recomputes >= scale`.

## Per-library harness shape — `linear-chain`

| Dimension | causl | jotai | mobx | redux-toolkit |
|---|---|---|---|---|
| Graph depth | `scale` derived nodes | `scale` derived atoms | `scale` `computed` cells | `scale` chained `createSelector`s (post-#873) |
| Head input | `g.input('a', 0)` | `atom(0)` | `observable.box(0)` | `slice.head` (`createSlice`) |
| Commits per `step` | 1 (`g.commit('bump', tx => tx.set(a, 1))`) | 1 (`store.set(head, 1)`) | 1 (`runInAction(() => head.set(1))`) | 1 (`store.dispatch(bumpHead(1))`) |
| Subscribers | 1 on tail (`g.subscribe(tail, tally)`) | 1 on tail (`store.sub(tail, tally)`) | 1 autorun reading tail | 1 (`store.subscribe(...)` that reads tail) |
| Recompute counter | `counter.wrap` per link | `counted<number>` per link | `counted<T>` closure per `computed` | `counted<State, number>` per `createSelector` |
| Equality / cutoff | Phase G/H `Object.is` cutoff | jotai atom `Object.is` cutoff | mobx `comparer.default` (`===`) | reselect output `Object.is` cutoff |
| End-state | `tail = scale` | `tail = scale` | `tail = scale` | `tail = scale` |

Verdict for `linear-chain`: **like-for-like**. Same chain depth, same
boundary count, same end-state, same 1-subscriber tap on the tail, same
Object.is-flavored cutoff semantics across all four. The redux harness
that #873 fixed (was a single Immer reducer; now a real reselect chain
of `scale` nodes) closes the only remaining asymmetry — and the
`recompute-count-parity` gate enforces it.

## Per-library harness shape — `scrolling-viewport`

| Dimension | causl | jotai | mobx | redux-toolkit |
|---|---|---|---|---|
| Cell count | `scale` inputs | `scale` primitive atoms | `scale` `observable.box`es | `scale`-length array in slice state |
| Per-step writes | `scale/stride` ≈ 100 | same | same | same |
| Stride | `max(1, floor(scale/100))` | same | same | same |
| Boundary per write | `g.commit('scroll-${i}', tx => ...)` | bare `store.set(cells[i], i)` (no batching primitive) | `runInAction(() => cells[i].set(i))` | `store.dispatch(slice.actions.set({index,value}))` |
| **Subscribers** | **`scale` (one per cell)** via `cells.map(cell => g.subscribe(cell, tally))` | **`scale` (one per cell)** via `cells.map(cell => store.sub(cell, tally))` | **`scale` (one autorun per cell)** via `cells.map(cell => notifierAutorun(() => cell.get()))` | **1** (store-level `store.subscribe(tally)`) |
| Notification semantics | tally fires once per changed cell | tally fires once per changed cell | autorun fires once per changed cell | tally fires once per `dispatch`, regardless of which index changed |
| Setup mount mode | eager (`g.input` materialises immediately) | lazy (atom materialises at first `store.sub`) | eager (`observable.box`) | eager (slice initial state allocates the full array) |
| Equality / cutoff | Phase B `Object.is` short-circuit at input | jotai `Object.is` short-circuit at primitive atom write | mobx `comparer.default` (`===`) | Immer-produced new state reference per dispatch — equality is per-action, not per-cell |

Verdict for `scrolling-viewport`: **NOT fully like-for-like** — see
findings below.

## Not-like-for-like findings

### F1. Subscriber-count asymmetry on `scrolling-viewport` (significant)

Three libraries (causl, jotai, mobx) attach **`scale` subscribers**, one
per cell — every per-step write fans out to exactly one observer (the
cell that just changed). Redux attaches **one** store-level
subscriber that fires once per `dispatch` and reads `getState()`. At
scale=10000 with stride=100 that is:

- causl/jotai/mobx: 100 observer-fire events per `step` (one per changed
  cell). The notification machinery is exercised.
- redux: 100 observer-fire events per `step` — but each invokes a
  single store-level subscriber that does no per-cell work in the tally
  closure. Redux pays for the dispatch + new state-array reference +
  one subscriber tick; the other three pay dispatch + per-cell
  notification dispatch + one subscriber tick **per touched cell**.

The observer-fire count *happens* to match because stride=floor
(scale/100) gives 100 boundaries per step and redux's single subscriber
also fires 100 times (once per dispatch). But the work shape is
different: redux's subscriber sees one fan-in event per dispatch;
the others see one fan-out event per changed cell. This is precisely
the apples-to-oranges class #873 was created to police, and unlike
`linear-chain`'s recompute counter there is **no conformance test
asserting subscriber-count parity** for `scrolling-viewport` today.

If a future engine optimisation shaves per-subscriber dispatch cost,
the causl/jotai/mobx cells move while redux stays put — for reasons
that have nothing to do with the scenario name.

### F2. Mount eagerness still un-gated in practice

`setup-time-parity.test.ts` exists (#873) but is **FLAG-only** — it
`console.warn`s when a library exceeds 2× the cross-library median
setup cost; it does not fail. Jotai's lazy atom mounting vs causl's
eager `g.input` materialisation still flows into the timed
`scrolling-viewport` cell wherever a `World.step` includes
construction-adjacent cost (per the #721 split, setup is mostly
outside the timed region, but `computeEndState` — the path that
`fair-fight-results.json` invariants ultimately compare against —
runs the full construction + workload each call). The flag is in the
right place; the gate is not.

### F3. Equality-semantics parity is genuine on `scrolling-viewport`

Every library short-circuits equal writes on `Object.is`:

- causl: Phase B input-stage `Object.is` filter (`packages/core/src/graph.ts`).
- jotai: `atomDispatch` `Object.is(prev, next)` before invalidating (commented in `jotai.ts` line 336).
- mobx: `comparer.default` (`===` for numbers; `Object.is` equivalent for the scenario's primitive-number writes).
- redux + reselect: input-tuple cache equality is `Object.is`; output cutoff also `Object.is`.

The `scrolling-viewport` step writes `i` to `cells[i]` (which starts
at 0), so all writes are **not** equal to prior values — every library
exits the fast-path and pays the full write cost. No short-circuit
asymmetry biases the cell. ✓

### F4. `linear-chain` is clean across all four

Same chain depth, same single subscriber on tail, same single bump,
same equality cutoff semantics, same recompute-count enforced by
`recompute-count-parity.test.ts`. Post-#873 the redux harness is no
longer the outlier.

## Recommendations

### R1. Add a subscriber-count parity invariant for `scrolling-viewport`

Add `packages/bench/test/conformance/subscriber-count-parity.test.ts`
that extracts each harness's `case 'scrolling-viewport':` block and
asserts the textual pattern `cells.map(...subscribe|sub|autorun...)`
is present — proving every library attaches one observer **per cell**,
not one store-level observer. Redux is the failing case today; the
fix is to change `store.subscribe(tally)` to per-cell selector
subscriptions (idiomatic redux pattern for cell-keyed state — one
`store.subscribe` with a per-cell selector + `Object.is` change detector
per cell). This brings redux's notification fan-out shape into line
with the other three and makes the cell a true per-cell-observer
benchmark.

This closes the same gap #873 closed for `linear-chain` recompute
shape and `equality-cutoff` cutoff-input shape — same family of
"workload shape inside the boundary" drift.

### R2. Promote `setup-time-parity` from FLAG to hard gate at 3×

The 2× FLAG threshold catches drift visually in CI logs but lets a
silent jotai-lazy vs causl-eager mount asymmetry flow into published
numbers if a maintainer ignores the warning. Promote to a **hard
failure at 3×** (with the 2× warn-only band preserved for early
signal). The 3× threshold tolerates the architectural lazy-vs-eager
delta (which is genuinely intrinsic) while failing on the
non-architectural drift the flag was designed to catch. Pair with a
documented opt-out via a per-scenario `// setup-parity-exempt: <reason>`
marker so the gate can be silenced explicitly when the asymmetry is
load-bearing for the comparison (with the marker auditable in code
review).

## Conclusion

`linear-chain` is fair across all four libraries today; the #873
recompute-count parity test backs that up.

`scrolling-viewport` is **mostly** fair after #678 — same boundary
count, same per-step semantics, same equality short-circuit behavior —
but ships **one residual asymmetry**: redux attaches a single
store-level subscriber where the other three attach `scale`
per-cell subscribers. The notification fan-out shape differs in a way
that is invisible to the existing fair-fight gate (which only counts
boundary calls) and the existing conformance gates (which cover
recompute counts and cutoff inputs, not subscriber fan-out). R1 above
closes that gap.

The #699 verdict — "not like-for-like" — was correct for the pre-#678
world and is now correct for #699's specific complaint (the mobx
single-runInAction batching artifact); it is **stale** as a general
indictment. The residual asymmetry on `scrolling-viewport` is
different in kind (subscriber fan-out, not boundary count) and
warrants its own conformance gate rather than reopening #699.
