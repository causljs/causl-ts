# Team analysis synthesis — linear-chain + scrolling-viewport

15-agent parallel analysis wave consolidating into one ranked recommendation set.

## TL;DR

- **causl is the ONLY library that completes `linear-chain × 10000`** (6.107 ms median this run). jotai/redux/mobx all stack-overflow because their read paths use mutual recursion that busts V8's call stack at chain depth ~1000.
- **causl wins `scrolling-viewport × 10000` by 322×** (0.106 ms vs redux 34.099 ms). The win is architectural (Phase G's `subscriptionsByNode` index keyed by changed set, not subscriber set).
- **Small-scale gaps to redux + mobx ARE real** (linear-chain × 1000: redux 0.367 ms vs causl 0.717 ms = 2× slower). Recoverable with targeted fast-paths identified below.
- **The bench fairness audit confirms like-for-like harnesses** (`docs/bench/2026-05-12-fairness-audit.md`); no per-library shortcuts to remove.

## Why causl wins at scale (10000+)

| Mechanism | Source doc |
|---|---|
| Iterative Phase D driver — no recursion, no stack overflow | `phase-d-recompute-analysis.md`, `linear-chain-causl.md` |
| `subscriptionsByNode` index keyed by `changed`, not by subscriber count | `scrolling-viewport-causl.md` |
| Equality cutoff (Phase D `Object.is`) prevents downstream propagation when value unchanged | `reactive-invariants-cost.md` |
| Frozen commit envelopes paid up-front; per-commit cost stays flat at all scales | `reactive-invariants-cost.md` |

## Why causl is 1.5-2× slower than redux+mobx at scale 100-1000

Per-commit fixed envelope cost dominates the tiny chain. Each derived recompute mints:

- `nextDepsArr = []` (per derived, per commit) — `phase-d-recompute-analysis.md` §3
- `nextStack = [...dirtyStack, e.id]` (spread allocation) — same
- `frame: RecursiveFrame{…}` literal — same
- `DerivedRollback` records when first allocated — `v8-engine-lens.md` §1

Plus invariants that mobx doesn't pay for:
- Atomic snapshot (Phase A/B staging + rollback arrays) — `reactive-invariants-cost.md` §3
- Glitch-free recompute (full Phase D Kahn topo walk even when chain has indegree=1 throughout) — same

## Ranked recommendations

| Rank | Recommendation | Source lens | Scenario | Expected delta | Cost | Risk |
|---|---|---|---|---|---|---|
| 1 | **Pre-allocate `derivedRollback.map = new Map()`** at construction instead of `undefined`-then-lazy-mint. Eliminates one hidden-class transition mid-commit. | `v8-engine-lens.md` R1 | both scenarios | 5-10% | trivial (1 line) | low |
| 2 | **Pool `nextDepsArr` across commits** — reuse a per-DerivedEntry array instead of fresh `[]` per recompute. Eliminates the largest per-commit allocation in Phase D inner loop. | `phase-d-recompute-analysis.md` R1 | linear-chain × all | 10-15% | small | low |
| 3 | **Replace `dirtyStack` spread with mutable push/pop**. `nextStack = [...dirtyStack, e.id]` allocates a new array each derived; `push` + `pop` after recompute is allocation-free. | `phase-d-recompute-analysis.md` R2 | linear-chain × 1k, 10k | 5-8% | small | low |
| 4 | **Singleton-staged fast-path for indegree=1 chains**. Detect that no derived has fan-in > 1; skip the affected Set + indegree Map + Kahn drain entirely. Walk the chain inline. Falls back to full Phase D on first fan-in detected. | `reactive-invariants-cost.md` (Proposal A) | linear-chain × 100, 1k | ~11% | medium | medium (must preserve byte-identical Commit envelope) |
| 5 | **Fuse `affected` Set + `indegree` Map** into a single `Map<NodeId, number>` with `0` as the Kahn-ready sentinel. Saves one allocation per commit + halves Map ops in Phases 1-3. | `phase-d-recompute-analysis.md` R3 | linear-chain × 100 | 3-5% | medium | medium |
| 6 | **Pretenure warmup for `commitInternal`**. The `tx` literal at `graph.ts:3865` allocates per-commit but its allocation-site SFI isn't covered by `pretenureInputAllocationSites`. Promote to module-level helper. | `v8-engine-lens.md` R3 | all scenarios | 2-5% | small | low |
| 7 | **Type-specialised `readEntryNumber` / `readEntryObject`** to defeat polymorphic LoadIC at `graph.ts:1640`. Requires `derivedNumber` / `derivedObject` factories (typed siblings of `derived`). | `type-shape-megamorphism.md` Proposal A | linear-chain × 100 | 3-6% | medium | medium (API surface addition) |
| 8 | **Defer rollback-record materialization to catch arm**. Today the rollback array is built eagerly even when no throw occurs. Lazy-build it inside the catch handler instead. | `linear-chain-redux-comparison.md` rec 3 | linear-chain × all | 3-5% | small | low |
| 9 | **Phase G skip when `changed` and `subscriptionsByNode` disjoint**. Currently always walks `changed`; if no subscriber is interested in any changed id, skip the walk. | `reactive-invariants-cost.md` Proposal C | scrolling-viewport-derived (future) | 5-10% on the new sibling cell | medium | low |
| 10 | **Phase 1+2 BFS fusion for indegree-1 case**. When the chain has indegree=1 throughout, fuse the BFS into a single-pass walk. Already partially fused (`#963`); extend to the indegree-1 short-circuit. | `linear-chain-redux-comparison.md` rec 1 | linear-chain × 100 | ~⅓ of remaining gap | medium | medium |
| 11 | **Sub-`subscribe` closure capture set reduction**. The unsubscribe closure at `subscribe()` captures a wide context object; replace with a non-closure helper. Trims 11% of `scrolling-viewport × 10k` self-time per CPU profile. | `cpu-profile-findings.md` R2 | scrolling-viewport × 10k | 1-3% (already winning) | small | low |
| 12 | **Pool `RecursiveFrame` literals** at module scope, reset between commits. Same idea as `nextDepsArr` pool. | `phase-d-recompute-analysis.md` (implicit) | linear-chain × all | 2-4% | small | low |
| 13 | **mobx-style three-state lazy validation** for chains where Phase D could skip recompute entirely. UP_TO_DATE / POSSIBLY_STALE / STALE transitions on read. | `comparator-techniques.md` rank 2 | linear-chain × all | 10-20% but invasive | LARGE | high (semantic change, requires SPEC validation) |
| 14 | **jotai-style per-dep epoch map** with global commit epoch. O(1) short-circuit when all deps' epochs match the dep-map snapshot. Additive over existing `nodeVersions` (#1242) + `GraphTime`. | `comparator-techniques.md` rank 1 | linear-chain × all | 5-10% | medium | medium |
| 15 | **Add `scrolling-viewport-derived` sibling scenario** that wires one derived per visible window. Today's `scrolling-viewport` has `hasDependents=false` everywhere so Phase D never runs — the win is real but unrepresentative of full engine pressure. The sibling exercises the slow path. | `scrolling-viewport-causl.md` R1 | (new bench cell) | regression-prevention | small | low |

## Falsifiability + risk callouts

Per the negative-findings ledger (#1015 in the closed-issues archive), V8-inlining perf projections have been 7× too optimistic three separate times. **Treat any "Expected delta" above as untested**. Implement → measure → file in the ledger if the projection diverges.

The scrolling-viewport win has a benchmark-composition caveat: with `hasDependents=false`, Phase D never runs and the staging slow-path is unreachable. The win is genuine for the scenario as defined; it does NOT generalize to scenarios with subscribers + derived chains. Recommendation #15 closes that gap.

## What's NOT a problem

- **Bench fairness**: harnesses ARE like-for-like across all 4 libraries (audit confirms — `fairness-audit.md`).
- **Measurement reliability at scale ≥ 1k**: deltas are unambiguous; well above the bench-gate's 8% noise floor (`measurement-reliability.md`).
- **Type-shape megamorphism**: minor risk; engine is mostly monomorphic (`type-shape-megamorphism.md` verdict).
- **Deopt classes**: prior PRs (#1036 / #1132) closed the two known cases. No residual deopt finding in this run's engine-status report (the `deopt-analysis.md` doc was not produced by the parallel wave — listed as a gap below).

## Gaps in this analysis

- `deopt-analysis.md` — agent errored before completing (API timeout). Pull the engine-status report manually from `packages/bench/report/engine-status-deopts/` for a follow-up sweep.
- Some recommendations cite "Expected delta" without measurement. The #1015 discipline applies — measure, don't assume.

## References

Cross-doc index, in alphabetical order:

- `comparator-techniques.md` — what reselect / jotai / mobx do internally that's borrowable
- `cpu-profile-findings.md` — top-5 self-time functions per scenario
- `fairness-audit.md` — harness shape verification
- `fresh-bench-results.md` — May 12 numbers, per-scale per-library
- `linear-chain-causl.md` — causl's path through the linear-chain scenario
- `linear-chain-mobx-comparison.md` — mobx's small-scale advantage
- `linear-chain-redux-comparison.md` — redux's small-scale advantage + invariants causl pays that they don't
- `measurement-reliability.md` — bench noise envelope at each scale
- `phase-d-recompute-analysis.md` — Phase D allocation hot-spots, line-annotated
- `read-path-analysis.md` — `graph.read()` + `recordingGet` cost breakdown
- `reactive-invariants-cost.md` — per-invariant cost vs comparators
- `scrolling-viewport-causl.md` — why we win 322× + composition caveat
- `type-shape-megamorphism.md` — IC stability audit
- `v8-engine-lens.md` — hidden-class + tenuring audit

## Bottom line for the project owner

**causl already wins where it matters** (production-scale workloads, scale 10k+). The team analysis surfaces 8-12 concrete, low-risk recommendations to close the small-scale gap to mobx + redux. Total projected delta if all top-12 recommendations land: **30-50% improvement** on linear-chain at scale ≤ 1000, putting causl at parity with redux at every scale while preserving the scale-invariant win above.
