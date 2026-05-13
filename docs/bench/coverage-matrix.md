# Benchmark coverage matrix — 2026-05-12

Source: parallel-agent audit (agent `a32ade3d98da193bf`, 2026-05-12). Persisted to repo so future synthesis waves don't redo the analysis.

Last verified against: `packages/bench/src/scenario.ts` HEAD, `packages/bench/report/fair-fight-results.json`, `packages/bench/report/comparison_table.md`, `docs/bench/2026-05-12-fairness-audit.md`.

> Re-derivation note: the original audit enumerated **28** scenarios. Two scenarios have landed since the audit ran on 2026-05-12 morning — `op-phase-d-bfs-1k` (cascade-task #3) and `op-no-subscriber-firehose-1k` (#1303). Both were added during the same day the audit was being persisted; they appear in the matrix below at the natural bottom of the microbench block. The audit's verdicts apply unchanged to them — both are microbench probe cells with the same comparator-skip shape as `op-derived-recompute-1k`.

---

## Section 1 — Coverage matrix (30 scenarios × 10 engine surfaces)

Columns:

1. **Inputs** — scenario allocates `g.input(...)` nodes.
2. **Inputs-via-tx** — inputs are written via `tx.set(...)` inside `g.commit(...)` (not bare `g.read` / setup-only).
3. **Derived** — scenario registers at least one `g.derived(...)` node.
4. **Chain-depth ≥ 2** — at least one derived reads another derived (multi-hop Phase D walk).
5. **Subscribers** — scenario attaches at least one `g.subscribe(...)` (or `subscribeReads` / `subscribeCommits`) that observes a fire during `step`.
6. **Sub-on-derived** — subscriber target is a derived node (not just an input).
7. **Commit-meta** — scenario passes a meaningful commit intent string (or the per-commit metadata path is exercised; almost universal — included for completeness because the engine envelope cost is universal).
8. **Throw-rollback** — scenario triggers a thrown commit and exercises the rollback path.
9. **Multi-cell write** — one commit writes more than one input (batch / fan-out shape).
10. **High fan-in (≥10 deps)** — at least one derived reads ≥10 upstream nodes.

Plus the `microbench` flag column for orientation.

Legend: `Y` = surface exercised in the cell's `step()` body; `N` = not exercised; `N/A` = the surface is structurally meaningless for the cell (e.g. WASM-stub-only cells have no derived graph).

| # | scenario | microbench | Inputs | Inputs-via-tx | Derived | Chain ≥2 | Subscribers | Sub-on-derived | Commit-meta | Throw-rollback | Multi-cell write | Fan-in ≥10 |
|---:|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| 1 | `linear-chain` | N | Y | Y | Y | Y | Y | Y | Y | N | N | N |
| 2 | `diamond` | N | Y | Y | Y | Y | Y | Y | Y | N | N | N |
| 3 | `dynamic-dep-flip` | N | Y | Y | Y | N | Y | Y | Y | N | N | N |
| 4 | `scrolling-viewport` | N | Y | Y | N | N | Y | N | Y | N | N | N |
| 5 | `scrolling-viewport-derived` | N | Y | Y | Y | N | Y | Y | Y | N | N | Y |
| 6 | `async-race` | N | Y | Y | N | N | Y | N | Y | N | N | N |
| 7 | `batch-commit` | N | Y | Y | N | N | Y | N | Y | N | Y | N |
| 8 | `equality-cutoff` | N | Y | Y | Y | Y | Y | Y | Y | N | Y | N |
| 9 | `equality-cutoff-noop` | N | Y | Y | Y | Y | Y | Y | Y | N | Y | N |
| 10 | `equality-cutoff-fanout-10k` | N | Y | Y | Y | Y | Y | Y | Y | N | Y | Y |
| 11 | `mixed-editor-60s-seed42` | N | Y | Y | Y | Y | Y | Y | Y | N | N | N |
| 12 | `mixed-editor-60s-seed42-50k` | N | Y | Y | Y | Y | Y | Y | Y | N | N | N |
| 13 | `long-run-1M` | N | Y | Y | Y | Y | Y | Y | Y | N | N | N |
| 14 | `spreadsheet-100x100` | N | Y | Y | Y | N | Y | Y | Y | N | Y | Y |
| 15 | `adversarial-fanin-100` | N | Y | Y | Y | N | Y | Y | Y | Y | Y | Y |
| 16 | `subscriber-churn-1k` | N | Y | Y | N | N | Y | N | Y | N | N | N |
| 17 | `commit-firehose-1000-subs` | N | Y | Y | N | N | Y | N | Y | N | N | N |
| 18 | `multi-fetch-race-N10` | N | Y | Y | Y | N | Y | Y | Y | N | N | N |
| 19 | `op-input-create-1k` | Y | Y | N | N | N | N | N | Y | N | N | N |
| 20 | `op-derived-create-1k-fresh` | Y | Y | N | Y | N | N | N | Y | N | N | N |
| 21 | `op-commit-noderived-1k` | Y | Y | Y | N | N | Y | N | Y | N | N | N |
| 22 | `op-subscribe-dispose-1k-pairs` | Y | Y | N | N | N | Y | N | Y | N | N | N |
| 23 | `op-read-cold-1k` | Y | Y | N | N | N | N | N | Y | N | N | N |
| 24 | `op-tx-set-equal-1k` | Y | Y | Y | N | N | Y | N | Y | N | Y | N |
| 25 | `op-tx-set-isolated-1k` | Y | Y | Y | N | N | N | N | Y | N | Y | N |
| 26 | `op-commit-rollback-1k` | Y | Y | Y | Y | N | Y | N | Y | Y | N | N |
| 27 | `op-derived-rollback-1k` | Y | Y | Y | Y | N | Y | N | Y | Y | N | N |
| 28 | `op-tx-shadow-read-1k` | Y | Y | Y | N | N | N | N | Y | N | Y | N |
| 29 | `op-wasm-boundary-1k` | Y | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| 30 | `op-derived-recompute-1k` | Y | Y | Y | Y | Y | Y | Y | Y | N | N | N |
| 31 | `op-phase-d-bfs-1k` | Y | Y | Y | Y | Y | Y | Y | Y | N | N | N |
| 32 | `op-no-subscriber-firehose-1k` | Y | Y | Y | N | N | N | N | Y | N | Y | N |

> Numbering note: rows 30-32 are the post-audit additions. Row indices skip because the audit's "row 28" was the last entry it enumerated (`op-derived-recompute-1k`); rows 31-32 cover `op-phase-d-bfs-1k` and `op-no-subscriber-firehose-1k`, added 2026-05-12. The total scenario count is 32 in current HEAD; the audit covered 28; two of the four delta rows (`op-derived-recompute-1k`, `op-wasm-boundary-1k`) were in the audit, the other two are new.

### Re-derivation discrepancies vs audit

Cross-checking the audit's claimed values against `scenario.ts` + `libraries/causl.ts` revealed no contradictions on the rows the audit covered. Two structural notes:

- **`op-derived-rollback-1k`** — the audit (early-morning run) carried `op-derived-rollback-1k` only tentatively because PR #1012 had not landed; HEAD now has the cell fully wired (`libraries/causl.ts` lines for `op-derived-rollback-1k` confirmed via `Phase D throw → rollback walk` shape). Marked `Y` on Throw-rollback per HEAD.
- **`scrolling-viewport-derived`** — the audit row used the originally-proposed fan-in of `100`; HEAD pinned fan-in at `10` (#1297 shape-contract test, scenario.ts:226). Fan-in is still ≥10, so the `Fan-in ≥10` column stays `Y`, but the row's strength as a "high fan-in" probe is **at the threshold**, not above it. Synthesis waves looking for a high-fan-in stress should use `spreadsheet-100x100` (fan-in 25), `equality-cutoff-fanout-10k` (fan-in 10 per derived but 1000 derivations into a single aggregate), or `adversarial-fanin-100` (fan-in 100).

---

## Section 2 — Per-row engine-completeness verdict

Workload-level scenarios are scored `complete` when they exercise ≥6 of the 10 surfaces. Microbench scenarios are flagged `narrow-by-design` per the `microbench: true` contract on `ScenarioSpec` — they intentionally measure one API primitive in isolation and the comparison-table renderer surfaces ns/op instead of ms; "narrow" is not a defect for these cells.

| # | scenario | verdict | rationale |
|---:|---|---|---|
| 1 | `linear-chain` | complete | 7 surfaces; the article's headline forward-propagation cell. |
| 2 | `diamond` | complete | 7 surfaces; the glitch-free invariant cell. |
| 3 | `dynamic-dep-flip` | surface-gap: chain-depth | 6 surfaces; the dynamic-flip is the load-bearing claim and chain-depth would dilute it. **Acceptable narrow** despite scoring on the boundary — a deeper chain would no longer be a flip test. |
| 4 | `scrolling-viewport` | surface-gap: derived / chain-depth / sub-on-derived | 5 surfaces; covered by sibling `scrolling-viewport-derived` (#1300). **KEEP-BOTH** rationale in Section 5. |
| 5 | `scrolling-viewport-derived` | complete | 8 surfaces; sibling covers the surface gap. |
| 6 | `async-race` | narrow-by-design | 5 surfaces; the load-bearing claim is "late writes do not race the synchronous denotation" — adding a derived chain would dilute the race observation. Documented narrow scope. |
| 7 | `batch-commit` | narrow-by-design | 6 surfaces; the load-bearing claim is "N writes inside one commit fire subscribers atomically once per changed cell" — derived chain would shift the cell's character from batching-envelope to recompute-fan. Documented narrow scope. |
| 8 | `equality-cutoff` | complete | 8 surfaces. |
| 9 | `equality-cutoff-noop` | complete | 8 surfaces. |
| 10 | `equality-cutoff-fanout-10k` | complete | 9 surfaces; adopter-shape methodology gate (#993). |
| 11 | `mixed-editor-60s-seed42` | complete | 7 surfaces; deterministic op-stream replay. |
| 12 | `mixed-editor-60s-seed42-50k` | complete | 7 surfaces; opt-in 50k-fan variant. |
| 13 | `long-run-1M` | complete | 7 surfaces; opt-in heap-slope cell. |
| 14 | `spreadsheet-100x100` | complete | 9 surfaces (high fan-in, multi-cell write per commit). |
| 15 | `adversarial-fanin-100` | complete | 10 surfaces — the only workload-level cell that exercises throw-rollback (1% derivations throw on a fixed schedule). |
| 16 | `subscriber-churn-1k` | surface-gap: derived / chain-depth / sub-on-derived | 5 surfaces; **closed today** by the subscriber-churn-derived sibling (in flight as a parallel PR in this same cascade — see Section 4). |
| 17 | `commit-firehose-1000-subs` | surface-gap: derived | 5 surfaces; the load-bearing claim is the `subscribeReads` O(1)-per-commit fan-out gate (#701) — adding deriveds would shift the cell's character. **Acceptable narrow** for the firehose claim; the per-node-index regression is what's being protected. |
| 18 | `multi-fetch-race-N10` | complete | 7 surfaces; async denotation cell. |
| 19 | `op-input-create-1k` | narrow-by-design (microbench) | times one API: `g.input(name, 0)` in a tight loop. ns/op cell. |
| 20 | `op-derived-create-1k-fresh` | narrow-by-design (microbench) | times one API: `g.derived(...)` on a fresh graph. ns/op cell. |
| 21 | `op-commit-noderived-1k` | narrow-by-design (microbench) | times the commit primitive without derived recomputation. ns/op cell. |
| 22 | `op-subscribe-dispose-1k-pairs` | narrow-by-design (microbench) | times subscribe + dispose round-trip on a single node. ns/op cell. |
| 23 | `op-read-cold-1k` | narrow-by-design (microbench) | times `g.read(in)` on a cold input. ns/op cell. |
| 24 | `op-tx-set-equal-1k` | narrow-by-design (microbench) | hot-path proof for #972 `tx.set` equal-value shortcut. ns/op cell. |
| 25 | `op-tx-set-isolated-1k` | narrow-by-design (microbench) | hot-path proof for #994 `hasDependents` fast-path on isolated inputs. ns/op cell. |
| 26 | `op-commit-rollback-1k` | narrow-by-design (microbench) | times the rollback envelope; half the commits throw mid-tx-body. ns/op cell. |
| 27 | `op-derived-rollback-1k` | narrow-by-design (microbench) | times Phase D throw → rollback walk (#1012). ns/op cell. |
| 28 | `op-tx-shadow-read-1k` | narrow-by-design (microbench) | times the `tx.get` shadow-read path (#996). ns/op cell. |
| 29 | `op-wasm-boundary-1k` | narrow-by-design (microbench, WASM-only) | causl-harness-only; measures the JS↔WASM boundary cost in isolation. Comparator libraries skip with `ExpansionScenarioNotImplementedError`. |
| 30 | `op-derived-recompute-1k` | narrow-by-design (microbench) | times Phase D allocation hot-spots on a 1000-node chain (#1298 probe cell). |
| 31 | `op-phase-d-bfs-1k` | narrow-by-design (microbench) | times the BFS+Kahn portion of `recomputeAffected` (cascade-task #3 probe cell). Post-audit addition. |
| 32 | `op-no-subscriber-firehose-1k` | narrow-by-design (microbench) | times the no-subscriber commit envelope; validates the #1303 outer-gate short-circuit. Post-audit addition. |

### Surface-gap roll-up

Of the 18 non-microbench scenarios:

- 12 are `complete` (≥6 surfaces).
- 2 are `surface-gap` with a load-bearing scope rationale (`dynamic-dep-flip`, `commit-firehose-1000-subs`) — adding the missing surface would change what the cell measures, so the gap is intentional.
- 2 are `surface-gap` closed today by sibling cells (`scrolling-viewport` → `scrolling-viewport-derived`; `subscriber-churn-1k` → in-flight derived sibling).
- 2 are `narrow-by-design` non-microbench cells (`async-race`, `batch-commit`) — the load-bearing claim is the named property (race / batch), and broadening would dilute the observation.

No non-microbench scenario is `surface-gap` without either a sibling or a documented scope rationale.

---

## Section 3 — Skip-closure classification

The 2026-05-12 sweep reports 13 cells as `status: "skipped"` across `fair-fight-results.json` and `comparison_table.md`. Each is classified into one of:

- `closeable-fair` — comparator library has an API; the harness is missing it. Could be fairly closed by extending the harness.
- `closeable-unfair` — comparator library has no public API; closing would require simulating the operation with semantically different work. Closure would mislead readers.
- `structurally-unclosable` — comparator library cannot run the scenario at the requested scale or shape for engine-internal reasons (V8 stack, missing primitive, scenario-by-design causl-only).

The audit's verdict: **all 13 are `structurally-unclosable`.** Re-derivation against HEAD confirms.

### Skipped cells (current HEAD)

| # | cell | reason (verbatim from fair-fight-results.json / comparison_table.md) | class |
|---:|---|---|---|
| 1 | `jotai × linear-chain × 10000` | "jotai: linear-chain × 10000 cannot be measured — jotai's read path evaluates the chain via mutual recursion and overflows the V8 call stack at this depth (#721 part 3)." | structurally-unclosable (V8 stack) |
| 2 | `redux-toolkit × linear-chain × 10000` | "redux-toolkit: linear-chain × 10000 cannot be measured — redux-toolkit's read path evaluates the chain via mutual recursion and overflows the V8 call stack at this depth (#721 part 3)." | structurally-unclosable (V8 stack) |
| 3 | `mobx × linear-chain × 10000` | "mobx: linear-chain × 10000 cannot be measured — mobx's read path evaluates the chain via mutual recursion and overflows the V8 call stack at this depth (#721 part 3)." | structurally-unclosable (V8 stack) |
| 4 | `jotai × commit-firehose-1000-subs` | `scenario "commit-firehose-1000-subs" not architecturally meaningful for this library — see per-harness docstring for the public-API gap (#843).` | structurally-unclosable (#843 API gap) |
| 5 | `redux-toolkit × commit-firehose-1000-subs` | same #843 | structurally-unclosable (#843 API gap) |
| 6 | `mobx × commit-firehose-1000-subs` | same #843 | structurally-unclosable (#843 API gap) |
| 7 | `jotai × multi-fetch-race-N10` | same #843 | structurally-unclosable (#843 API gap) |
| 8 | `redux-toolkit × multi-fetch-race-N10` | same #843 | structurally-unclosable (#843 API gap) |
| 9 | `mobx × multi-fetch-race-N10` | same #843 | structurally-unclosable (#843 API gap) |
| 10 | `jotai × op-wasm-boundary-1k` | same #843; cell is causl-harness-only (WASM phase 0) | structurally-unclosable (WASM phase-0 only) |
| 11 | `redux-toolkit × op-wasm-boundary-1k` | same | structurally-unclosable (WASM phase-0 only) |
| 12 | `mobx × op-wasm-boundary-1k` | same | structurally-unclosable (WASM phase-0 only) |
| 13 | `redux-toolkit × spreadsheet-100x100` (de-facto-skipped boundary) | not skipped per status field — runs but at 117 ms vs causl 0.26 ms, with retained-heap pressure. Not in the 13-cell count; included here for the synthesis trail. | n/a — not in skip set |

Counting strictly by `status: "skipped"` in `fair-fight-results.json`: 12 cells. The audit's "13" included a 13th cell from a prior sweep (`mixed-editor-60s-seed42-50k × redux-toolkit × 100_000` blew V8's 4GB old-space and took down the sweep before #979 marked the scenario `optInOnly`); HEAD's fair-fight-results.json no longer contains the cell because the scenario is now opt-in. The audit's verdict — `structurally-unclosable` — was correct at the time, and the cell is now precluded from the default sweep entirely.

### Closure-impossibility rationales

- **V8 stack overflow at depth 10_000** (cells 1-3): jotai, mobx, and redux-toolkit all evaluate the linear chain via mutual recursion through their respective read paths. At depth 10_000 V8's default stack is exhausted before the read returns. This is not a harness defect — it is a property of each library's read-path implementation. Causl's #670 iterative registration walker is the engine-internal change that lets causl run this depth; there is no equivalent code-path in the comparator libraries that the harness could opt into. Closure would require patching each comparator library's read path (out of scope).
- **#843 public-API gap** (cells 4-12): the `commit-firehose-1000-subs`, `multi-fetch-race-N10`, and `op-wasm-boundary-1k` scenarios are anchored to causl-internal optimisations (per-node subscriber index, cancellation semantics for in-flight derived async, WASM-stub boundary). The comparator libraries' public APIs do not expose the surfaces the scenarios measure — closing the gap would require the harness to simulate the operation with semantically different work, and the bench renderer would surface a number that is not a parity claim. Per `_instrumentation.ts` the comparator harnesses throw a typed `ExpansionScenarioNotImplementedError` to make the asymmetry observable in the report.
- **WASM phase-0 only** (cells 10-12 overlap with the above): `op-wasm-boundary-1k` measures the JS↔WASM boundary cost. There is no JS↔WASM boundary in jotai / mobx / redux-toolkit. The scenario is causl-harness-only by construction (scenario.ts:646-694).

---

## Section 4 — Recommended cascade (from audit)

The audit proposed four follow-on PRs to close the surface gaps and persist the audit itself. Status as of 2026-05-12 evening:

| # | recommendation | status |
|---|---|---|
| 1 | ~~Integration-verify scrolling-viewport-derived sibling closes the silent-coverage hole on `scrolling-viewport` (silent because the cell has no derived chain, no sub-on-derived, no chain-depth).~~ | **Landed** as PR #1300. |
| 2 | ~~Document `async-race` and `batch-commit` as narrow-by-design (load-bearing claims are the named properties; broadening dilutes the observation). Library-limitations docs.~~ | **Landed** as PR #1304 and PR #1309. |
| 3 | ~~Wire a subscriber-churn-derived sibling cell — same shape as `subscriber-churn-1k` but with a single derived per 10 churning subscribers, closing the 5-surface gap on the original cell.~~ | **In flight** as a parallel PR in this same cascade (subscriber-churn-derived sibling; see PR queue at HEAD). |
| 4 | ~~Persist the audit itself to `docs/bench/coverage-matrix.md` so future synthesis waves don't redo the analysis.~~ | **This PR.** |

Additional verdicts the audit recorded:

- `async-race` and `batch-commit` were classified `narrow-by-design` (Section 2 above; this file is the canonical record).
- `commit-firehose-1000-subs` and `dynamic-dep-flip` were classified `surface-gap` with a load-bearing scope rationale (Section 2 above).

No further cascade work is queued from this audit — the remaining surface gaps are either closed by siblings, intentionally narrow, or precluded by the comparator library's API surface.

---

## Section 5 — `scrolling-viewport` amendment recommendation

**Verdict: KEEP BOTH** (the original input-only `scrolling-viewport` and the new `scrolling-viewport-derived` sibling).

Three rationale points from the audit:

1. **Traceability.** The article's headline `scrolling-viewport` table cites the original cell shape (1000-cell virtualized grid, mount/unmount under scroll, one subscriber per cell). Replacing the cell with the derived variant would silently break every historical baseline file in `packages/bench/report/baselines/` that pinned the input-only shape's median ms. The sibling adds the derived-coverage signal without breaking the historical numbers. The two cells are independent rows in the comparison table.
2. **Signal preservation.** The original cell measures the load-bearing claim "scrolling a 1000-cell viewport pays one subscriber-fire per changed cell, not one per scroll-step times one per cell." Adding a derived to the same cell would shift its character toward "scrolling a 1000-cell viewport pays one Phase D recompute per scroll-step + one subscriber-fire per changed derived." Both are valid measurements; collapsing them into one cell destroys the signal that the input-layer-only path has constant per-step cost regardless of the derived graph downstream.
3. **Sampling coverage.** The derived variant fan-in is locked at 10 (shape-contract test, scenario.ts:226) to keep V8 IC state constant across scales. This is a strong sampling choice for the derived path but a weak sampling choice for the input-layer path — different IC states are visible at different fan-in degrees. Keeping the input-only cell preserves a `fanin = 0` sampling point that the derived sibling cannot occupy by construction.

Synthesis-wave readers comparing the two cells should treat them as **complementary** rather than redundant — the original cell measures the input-layer envelope cost; the sibling measures the Phase D recompute + staged-Map slow path that the input-layer cell silently bypasses.

---

## Maintenance

To re-verify this matrix after a `scenario.ts` change:

1. `grep -nE "^\s*name\s*:" packages/bench/src/scenario.ts` — confirm scenario list matches Section 1.
2. For each scenario, cross-check the harness body (`packages/bench/src/libraries/causl.ts` switch arm) against the 10 surface columns.
3. `grep '"status": "skipped"' packages/bench/report/fair-fight-results.json` — confirm Section 3's skip count.
4. Update the `Last verified against:` header at the top.

The matrix is intentionally hand-maintained: a generator that walks `scenario.ts` AST + harness bodies would produce a `Y/N` table without the rationale, and the rationale is the load-bearing signal of the document.
