# `@causl/core/testing`

> Shared test helpers for the Causl ecosystem. **Test-only**. Do not import from production code.

## Why this exists

Every package in the monorepo, plus several open PRs (Adoption Epics A, B, E, G), reinvents the same primitives — recompute counters, diamond glitch detectors, render spies, snapshot-equality assertions, property-trial wrappers — with subtly different semantics. The cost is real: the variants disagree on what a recompute *is* (engine `compute()` invocation? observer fire? React render?), property suites under-trial below the engine's contracted floor of ≥1000 random graphs and ≥1000 random commit sequences per property per CI run, and downstream tests pass for different reasons in different packages.

This module is the canonical implementation. Once a helper lands here, every PR consuming it inherits the same definition, the same trial floor, the same noise-budget discipline.

## What's in here

| Helper | Returns | Used by |
|---|---|---|
| `recomputeCounter(graph)` | `{ count(): number; reset(): void; dispose(): void }` | Epic A #180, Epic E #194, Epic G #201 |
| `glitchDetector(graph, derived, expected)` | `{ observed: number; isGlitched(): boolean }` | Epic G #201, Epic B-Concurrent #189 |
| `assertConsistentGraphTime(trace)` | throws on inconsistency | Epic B-Concurrent #189 |
| `assertResultStability({ getSnapshot })` | throws when ref changes without commit | Epic B-Concurrent #187 |
| `propertyTrials(label)` | `fast-check` config wrapper enforcing the SPEC §15.2 ≥1000-trials-per-property floor | every property suite |
| `tieredPropertyTrials(label)` | Tier-aware variant of `propertyTrials` — resolves `CAUSL_FUZZ_TIER` / `CAUSL_FUZZ_TRIALS` so PR (5k) and nightly (100k) budgets fire without per-callsite edits (post-#1097 / #1153) | property suites that opt into the tier system |
| `propertyDag(opts)` / `buildPropertyDag(spec, graph)` | random-DAG generator + builder for property tests (#297) | cross-backend determinism, atomicity, dynamic-dep suites |
| `arbAdversarialValue(opts?)` | `fast-check` arbitrary biased ~30% toward NaN / signed-zero / boundary / long-string / deep-object cases (#1073) | cross-backend determinism gate |
| `disposedTombstoneSize(graph)` | size of the engine's disposed-tombstone ring (#251) | bounded-tombstone-cap property suite |
| `commitLogConsumerCount(graph)` | active `commitLog` consumer count (#715 follow-up) | Phase F.4 skip-rebuild assertion |
| `derivedDeps(graph, id)` | live `deps` Set on a derived's internal entry (#703) | dep-shift / rollback property suites |

### Helpers that have moved

- `narrowCapability(graph)` is now exported from `@causl/core/internal` (capability narrowing is also relevant to adapters, not just tests; see #372 / #376 / #385).
- `renderSpy<P>(Component)` was scoped out of this engine-level seam — render-counting belongs in the consuming framework's own test helpers, not in `@causl/core/testing`. `@causl/react` callsites use `act`/`render` from `@testing-library/react` directly.

## Anti-features (deliberately not here)

- **No production code.** This module is excluded from `@causl/core`'s published bundle (`package.json` `exports` field exclusion + `size-limit` lint).
- **No assertion DSLs.** Tests should read like specifications; we use `vitest`/`fast-check` directly.
- **No mocks of the real engine.** Helpers wrap the real `Graph`; nothing is faked.

## Versioning

The testing surface is versioned independently of `@causl/core`'s public API. A change here is **not** a public API change of the engine. The contract for users of this module: imports look like `import { recomputeCounter } from '@causl/core/testing'`.
