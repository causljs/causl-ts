# Race-detection CI tiers — budgets, gates, graduation

> Per SPEC §16.6 and EPIC-6. Codifies the tier-graduation criteria the audit (#573) called out as undocumented.

> **Current state (as of v0.9.0).** The three-tier scaffold below is
> the **design contract** for race detection per SPEC §16A.3. What
> actually runs in CI today is split across two narrower workflows
> while the three-tier composer is parked:
>
> - `.github/workflows/four-way-classifier.yml` (#1070, EPIC-7)
>   runs the four-way differential classifier (TS engine + WASM
>   serde bridge + WASM gc-builtins bridge + Rust enumerator) on
>   every PR that touches a relevant path, and nightly at 07:15 UTC
>   against the EPIC-7 corpus + canonical-seed registry.
> - `.github/workflows/cross-backend-fuzz.yml` (#1073 / PR #1097)
>   runs the nightly 100 000-trial cross-backend determinism gate
>   at 04:00 UTC. PR-lane budgets are set by
>   `resolveCrossBackendFuzzTier()` in
>   `packages/core/test/properties/seed.ts` and default to the
>   1000-trial floor.
> - `.github/workflows-disabled/race-detection.yml` and
>   `.github/workflows-disabled/race-class-anchor-rule.yml` are the
>   scaffolded three-tier composer and the §17 commitment 5 race-row
>   PR-template lint, parked behind the `.github/workflows-disabled/`
>   gate until the enumerator's K=10/D=5 oracle list (Tier 2) and
>   the Apalache differential corpus (Tier 3) are wired in.
>
> The post-#1141 rename ("four-way classifier" → an as-yet-unshipped
> umbrella name covering both the four-way leg and the §16A
> three-tier scaffold) has been proposed but not landed; this doc
> still uses "tier" to refer to the design contract and names the
> shipped four-way workflow explicitly where current.

## The three tiers

The race-detection pipeline runs in three tiers with explicit time/coverage trade-offs. Every PR must clear Tier 1; main-branch pushes also clear Tier 2; nightly runs all three.

| Tier | Trigger | Time budget | Scope |
|---|---|---|---|
| **Tier 1** | every PR | ≤2 min | static IR linter (`causl-check`, all 12 passes) + property fuzz at 1000-trial floor |
| **Tier 2** | push to main, or PR labelled `race-detection-tier-2` | ≤15 min | bounded enumerator at K=10 / D=5 |
| **Tier 3** | nightly cron (02:30 UTC) + workflow_dispatch | ≤2 hr | bounded enumerator at K=20 / D=8 + Apalache differential corpus |

Workflow file: `.github/workflows-disabled/race-detection.yml` —
scaffolded; parked until Tier 2/3 oracles are wired (see current-state
callout above).

## What each tier covers

### Tier 1 — fast PR gate

- **causl-check static passes**: schema validation, bounds, unknown-dep, cycle, determinism, glitch-propagation, monotonic-commit, orphan-dep, subscribe-without-dispose, use-after-dispose, cross-graph-read, commit-from-subscribe.
- **Property fuzz** at the 1000-trial floor (per `spec-15.2-conformance.test.ts` walker enforcement) for `@causl/core`'s closed-DU invariants.
- Refusal-to-run on bound exceedance — `causl-check` short-circuits if the IR exceeds `--max-nodes` or `--max-commits`, surfacing the truthful "model too big for this tier" verdict rather than silently truncating.

### Tier 2 — bounded enumerator (medium)

- Bounded BFS over the IR's reachable state space at **K=10 actions, depth=5**.
- Oracles fired at each visited state: cycle reachability, glitch-propagation invariants, dynamic-dependency cleanup.
- Visited-set capped at 2^16 entries (~64k); `bounded_out: true` reported in the SARIF run when the cap is hit.
- Acceptance: zero unbounded races detected within the K=10/D=5 envelope.

### Tier 3 — enumerator + Apalache (slow, nightly)

- Bounded BFS at **K=20 actions, depth=8** — the SPEC §16.6 ship-gate parameters.
- Visited-set cap raised to 2^20 (~1M).
- Apalache differential corpus: each TLA+ model in `tools/enumerator/corpus/apalache/` runs through both Apalache (TLA+ form) and the Rust enumerator (IR form) with the same property assertions. The verdicts must agree on every model — a divergence is a defect somewhere.
- Apalache 0.47.2 is fetched in CI; on fetch failure the diff step downgrades to a warning rather than failing (Apalache's GitHub Releases API is occasionally rate-limited).

## Tier-graduation criteria

A model graduates from Tier 1 to Tier 2 when:

1. **Coverage gap.** A §9.1 race row that the static linter cannot fully decide remains uncovered by Tier 1's property fuzz at the 1000-trial floor. Most commonly: rows whose proof requires reasoning over async-resolution interleaving (row 6, row 11) or over `Msg`-dispatch traversal (row 9).
2. **Adopter request.** A team integrating `@causl/sync` or `@causl/devtools-bridge` requests deeper bounded-enumerator coverage on a specific PR by applying the `race-detection-tier-2` label.
3. **Differential-test pin.** A change to the engine's commit pipeline (Phase A–H), the conflict-registry mutators, or the resource-state machine. These are the load-bearing surfaces SPEC §16.7 names as the Apalache corpus's anchors.

A model graduates from Tier 2 to Tier 3 when:

1. **Schema bump.** Any change to `CauslModel` IR, the `IrEvent` discriminated union, or the `IrScope` / `IrBridge` registries. The Apalache corpus must re-confirm its agreement against the new schema.
2. **Enumerator algorithm change.** Any change to the BFS skeleton, the visited-set policy, or the oracle list. The K=20/D=8 envelope is the ship-gate proof of soundness.
3. **Pre-release pin.** Every release candidate runs the Tier 3 nightly job at least once before the version stamp lands.

## Owning the dial

The release manager (currently the engineer cutting the patch release) owns the tier-graduation dial. A PR that wants Tier 2 coverage applies the label; the release manager removes labels that don't have a stated reason in the PR body. A future PR moves this from informal review to a `tier-justification:` PR template field.

## Budget enforcement

- Tier 1's 2-minute budget is enforced by GitHub Actions' `timeout-minutes: 5` on the job (3-minute slack for setup overhead). A Tier 1 step that exceeds the budget surfaces as a job timeout — the tier itself fails closed.
- Tier 2's 15-minute budget uses `timeout-minutes: 20`.
- Tier 3's 2-hour budget uses `timeout-minutes: 130`.

When a tier exceeds its budget, the response is to **shrink the tier** (reduce K / D / visited-cap), NOT extend the budget. The whole-pipeline contract is "Tier 1 stays under 2 minutes per PR" — slipping that defeats the gate's design purpose.

## CLI flags supporting replay

The `causl-check` CLI ships three operator-facing flags that compose with the tier pipeline (per #592 / #572):

- `--replay <report-path>` — verdict-determinism gate. Captures a saved JSON report and re-runs the checker against the same model to confirm the verdict reproduces. Distinct exit code 3 on divergence.
- `--suppress <rule-id>=<reason>` — programmatic per-rule suppression. Use sparingly; every suppression requires a non-empty justification per SPEC §17 commitment 7.
- `--source <path>[=<uri>]` — per-site magic-comment suppression source. Reads the file, applies `// @causl-allow:RuleId — reason: ...` directives to the report before the exit-code gate. Repeatable; SPEC §16A.2.1 / GAP-A8-1 (#572).

Issue #573 (closed) tracked the `causl-check race` subcommand and
`--seed <hex>` for deterministic BFS replay. **Current state (as of
v0.9.0):** the closure was administrative (no associated PR), and
verification against `tools/checker/src/main.rs` confirms neither
`race` subcommand nor `--seed` flag shipped. The closest live
construct is the seed handling in
`packages/core/test/properties/seed.ts`'s
`resolveCrossBackendFuzzTier()` (#1073 / PR #1097), which is the JS
fuzz-tier resolver, not a Rust-enumerator replay flag. A future PR
either reopens #573 with a real implementation or files a follow-up
when the deferred enumerator lands.
