# CPU profile findings — linear-chain & scrolling-viewport

Date: 2026-05-12
Source profiles:
- `packages/bench/report/profiles/cpu/causl-linear-chain-1k/CPU.20260508.143055.82400.0.001.cpuprofile`
  (`pnpm tsx packages/bench/src/profile/cells/causl-linear-chain-1k.ts`, 50 × `runOnce(scale=1000)`, `--cpu-prof-interval=100`, 159.5 ms sampled)
- `packages/bench/report/profiles/cpu/causl-linear-chain-1000/CPU.20260510.114601.14942.0.001.cpuprofile`
  (`pnpm bench:profile:cpu causl linear-chain 1000`, harness runner, 232.2 ms sampled, much heavier ESM-loader noise)
- `packages/bench/report/profiles/cpu/causl-scrolling-viewport-10k/CPU.20260508.142123.71725.0.001.cpuprofile`
  (`pnpm tsx packages/bench/src/profile/cells/causl-scrolling-viewport-10k.ts`, 30 × `runOnce(scale=10000)`, `--cpu-prof-interval=50`, 263.7 ms sampled)
- `packages/bench/report/profiles/cpu/causl-scrolling-viewport-10000/CPU.20260510.114609.15105.0.001.cpuprofile`
  (`pnpm bench:profile:cpu causl scrolling-viewport 10000`, harness runner, 261.9 ms sampled)

Sibling INTERPRETATION.md files exist under the `-1k` / `-10k` dirs (post-#912 captures); the `-1000` / `-10000` dirs do not — they are harness-runner runs with the per-PR isolated install (`/private/tmp/causl-1040-iso`), which inflates ESM-loader self-time and is **not** the right baseline for engine analysis. All engine-frame readings below come from the `-1k` / `-10k` cell-driver profiles. Numbers re-derived from the raw `.cpuprofile` JSON with a self-time aggregator (`samples` + `timeDeltas`, grouped by `functionName|url|lineNumber`).

If you need fresh profiles, run:

```bash
pnpm tsx packages/bench/src/profile/cells/causl-linear-chain-1k.ts
pnpm tsx packages/bench/src/profile/cells/causl-scrolling-viewport-10k.ts
# Or via the bench harness (heavier ESM-loader frames; less useful for engine work):
pnpm --filter @causljs/bench run bench:profile:cpu causl linear-chain 1000
pnpm --filter @causljs/bench run bench:profile:cpu causl scrolling-viewport 10000
```

## causl × linear-chain × 1k — top 5 by self-time

Workload: build a 1000-node derived chain, subscribe the tail, commit a single input bump; repeat 50×. Main-thread total: **159.5 ms**.

Engine frames only (loader / GC / runtime filtered):

| Rank* | Self %  | Self (µs) | Function (file)                                | Approx. lines | Role |
| ---:  | ------: | --------: | ---------------------------------------------- | ------------: | ---- |
| E1 (#3 overall) | 10.52% | 16785 | `recomputeAffected` (`graph.ts` 3185–3405)        | ~221 | Phase D fused BFS + Kahn topo walk over the 1000-link chain |
| E2 (#6)         |  3.76% |  5993 | `setDepsFromArray` (`graph.ts` 1915–1997)         |  ~83 | Per-derived dep-array structural-sharing fast path (#880) |
| E3 (#9)         |  2.10% |  3350 | `derived` (`graph.ts` 2709–~2900)                 | ~200 | Derived-node graph constructor (50 × 1000 = 50 000 calls) |
| E4 (#10)        |  2.03% |  3239 | `computeDerivedIterative` (`graph.ts` 2437–2600)  | ~164 | Iterative per-derived recompute body |
| E5 (sub-1%)     |  ~0.9% |  ~1400 | `phaseD_recomputeAffected` + `commitInternal`     |  trampoline + envelope | Phase D trampoline (#878) + commit envelope |

\* Ranks include `compileForInternalLoader` 15.28%, `makeSyncRequest` 12.53%, `waitForWorker` 7.98%, GC 6.63% (tsx ESM loader + V8 native — ignorable for engine analysis).

Headline: `recomputeAffected` is the only engine frame above 5%. Matches the post-#912 INTERPRETATION.md exactly.

## causl × scrolling-viewport × 10k — top 5 by self-time

Workload: build 10 000 input cells, subscribe each, scroll the dataset by bumping every 100th cell (stride=100 → 100 commits per iter); repeat 30×. Main-thread total: **263.7 ms**.

Engine frames only:

| Rank* | Self %  | Self (µs) | Function (file)                                 | Approx. lines | Role |
| ---:  | ------: | --------: | ----------------------------------------------- | ------------: | ---- |
| E1 (#1 overall) | 13.88% | 36614 | `subscribe` (`graph.ts` 4981–5066)                  | ~86  | Per-cell observer registration — 300 000 calls |
| E2 (#2)         | 11.39% | 30033 | `input` (`graph.ts` 2615–2687)                      | ~73  | Per-cell input-node allocation — 300 000 calls |
| E3 (#3)         | 10.98% | 28969 | `(anonymous)` (`graph.ts` line ~1356 in dist)       | n/a  | `subscribe`-internal closure (likely the unsubscribe lambda) |
| E4 (#9)         |  2.68% |  7065 | `getEntry` (`graph.ts` 1590–1600)                   |  ~11 | Entry lookup — `entries.get(id)` + missing-entry throw |
| E5 (#12)        |  1.94% |  5117 | `makeInputNode` (`graph.ts` 576–578)                |   ~3 | Input-node literal allocator |

\* Ranks include GC 10.81%, `compileForInternalLoader` 9.53%, `makeSyncRequest` 8.37%, `waitForWorker` 5.28% (loader / GC noise).

Headline: the commit pipeline is invisible — `commitInternal` is **0.42%**, `recomputeAffected` is sub-1%, `anyInputSubscriberIn` (the pre-#854 hotspot) is <0.1%. The cell is **graph-construction-bound**, not commit-bound, and has been since #854.

## Suspicious frames — possible polymorphic call sites

1. **`getEntry` at 2.68% / ~11 lines on scrolling-viewport**. The function body is essentially `entries.get(id)` + a not-found `throw`. 2.68% of 263 ms across an ~11-line function is high for what should be a single `Map#get` + branch. Two megamorphic suspects: (a) the `entries` Map's value shape is the `Entry` union of `InputEntry | DerivedEntry`, so V8 sees a polymorphic load-and-return; (b) every caller pulls a different `Entry` subtype from the same call site, defeating monomorphisation. Worth checking the inline cache state with `--allow-natives-syntax %DebugPrint` or `--trace-opt`.

2. **`makeInputNode` at 1.94% / ~3 lines on scrolling-viewport**. A ~3-line literal-object allocator pulling 1.94% of total time is high. The lit-object shape (`{ id, kind: 'input' }` or similar) should be perfectly monomorphic, so the cost is almost entirely the allocation itself — meaning the Scavenge cost of 300 000 fresh input-node objects per profile. Pretenuring (`pretenureInputAllocationSites`, line 757) may not be firing for this allocation site.

3. **`(anonymous)` at 10.98% inside `subscribe`** (scrolling-viewport). The 10.98%-anonymous frame at `graph.ts:1356` in the dist bundle almost certainly corresponds to the closure returned from `subscribe` (the unsubscribe lambda, lines 5053–5065 in source). Hot at 10.98% with 300 000 instantiations per profile is mostly closure allocation; the closure captures `sub`, `node.id`, and reads from `subscriptions` / `subscriptionsByNode` / `commitLogConsumerCount` / `transientSubscriberCount`. The capture set is wide enough that V8 likely materialises a `Context` per closure.

4. **`setDepsFromArray` at 3.76% on linear-chain** (~83 lines). Already optimised by #880 to short-circuit on unchanged dep-array hash; the residual cost is the hash computation + Path-1 entry. p90 over a 20-run distribution is 3.95%, threshold currently 4.5% — close to detection.

## Recommendations

1. **Investigate `getEntry` IC state on scrolling-viewport** (2.68% of 263 ms in ~11 lines). If V8 has marked the `entries.get(id)` call site polymorphic because `Entry` is a union, an `InputEntry`-specialised lookup helper used from `subscribe` / `commitInternal` hot paths could halve the cost. Alternative: split `entries` into `inputEntries` + `derivedEntries` maps (already partially what `dependents` is), at the cost of a callable-name branch in callers.

2. **Reduce the `subscribe` returned-closure capture set**. The 10.98% anonymous frame is the unsubscribe lambda; it captures `sub`, `node.id`, and four enclosing-scope counters (`commitLogConsumerCount`, `transientSubscriberCount`) + two maps. Moving the unsubscribe body to a non-closure helper (`unsubscribeSub(sub, nodeId)`) and returning `() => unsubscribeSub(sub, node.id)` would shrink the per-subscriber `Context` to a 2-slot one, which V8 can often elide entirely.

3. **Confirm input-node pretenuring**. `makeInputNode` at 1.94% / 3 lines × 300 000 calls suggests young-gen Scavenge churn. `pretenureInputAllocationSites` (line 757) is supposed to push these to old-gen — verify it runs before the scrolling-viewport workload (or hoist the input-node literal out of `makeInputNode` into a module-scope template that's `Object.assign`-ed; pretenuring is allocation-site-keyed).

## Cross-check against existing INTERPRETATION.md

- linear-chain numbers reproduce the post-#912 INTERPRETATION.md table (`recomputeAffected` 10.52%, `setDepsFromArray` 2.70%/3.76% top-rank — small ranking shift because the existing doc merges loader-worker frames into the main thread, while this re-derivation uses raw same-node aggregation). Hypothesis `linear-chain` still **PASS**.
- scrolling-viewport numbers also reproduce the post-#912 INTERPRETATION.md table. Hypothesis `scrolling-viewport` still **PASS**.

No regression; this doc is informational, not a gate.
