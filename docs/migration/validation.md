# End-to-end migration validation (#164, #225)

This page is the contract for what "migration succeeded" means at
the codebase level — and the procedure that confirms it. The
v0 of this doc (under #199) was prose-only; #225 turned the four
axes into machine-checkable evidence, and the harness has been in
place since.

## What we validate (the four-axis contract)

| # | Axis | Machine evidence | Where it lives |
| --- | --- | --- | --- |
| 1 | **Syntactic clean** | `DriftReport.findings.length === 0` | `packages/migration-check/test/fixtures.after.test.ts` (per-library after/ trees) |
| 2 | **Behaviour parity** | 1000+ random `Msg` sequences agree between oracle and migrated implementations (SPEC §15.2 floor) | `packages/migration-check/test/properties/parity.property.test.ts` |
| 3 | **No bridge holdovers** | Forbidden-import regex returns empty over every after/ tree | `packages/migration-check/test/fixtures.after.test.ts` |
| 4 | **Drift report stable** | `DriftReport.catalogueVersion === '0.1'` and `schema === 2` | `packages/migration-check/test/fixtures.before.test.ts` |

Each axis has a regression-net test that fails red on injected
breakage and stays green when the canonical fixtures honour all
four axes.

## Pinned environment

The validation gate is reproducible across machines and CI runs
under exactly this environment. A contributor running the
procedure locally must verify their environment matches before
treating a green run as evidence.

| Knob | Value | Source |
| --- | --- | --- |
| Node | `24.x` | `.github/workflows/*.yml` (`node-version`) |
| pnpm | lockfile-pinned via `pnpm/action-setup@v4` | `.github/workflows/*.yml` |
| OS | `ubuntu-latest` | `.github/workflows/*.yml` (`runs-on`) |
| Trial floor (parity property) | `1000` per property | `packages/core/test/spec-15.2-conformance.test.ts` |
| Flake budget | `0.01` failure rate over a 30-day rolling window | `packages/migration-check/test/flake-budget.json` |
| Bundle-size budget (runtime packages) | enforced by `pnpm size` | root `package.json` `size-limit` — see **Current state** below. |

> **Current state (as of v0.9.0) — bundle budgets.** Earlier drafts
> of this doc cited the small-bundle promise from the pre-#458 era
> (`@causl/core` 6 KB, `createCausl`-only 4 KB, `@causl/react` 3 KB,
> `@causl/devtools-bridge` 3 KB). PR #458 retired those ceilings —
> the team accepted that the small-bundle promise was costing more
> in adopter glue (per closed PRs #266, #395, #420, #383, #455,
> #390, #454) than it was earning in elegance. The size-limit cells
> in root `package.json` are the current source of truth; today
> they ratchet `@causl/core (full import)` at 20 KB,
> `createCausl`-only at 15 KB, `@causl/react` at 8 KB,
> `@causl/devtools-bridge (connectDevtools-only)` at 5 KB, and
> `@causl/sync` at 12 KB. The wasm-pkg cells (serde-json /
> gc-builtins / gc-classic) gate the raw `.wasm` artefact per
> bridge under the #1063 / #1085 closeout; see
> `packages/core/wasm-pkg/README.md` and SPEC §17.6 (amended
> under #1150) for the Brotli q11 caps and the documented
> 213 KB serde gap.

A bump in any of these values is a required-action signal — it must
be coordinated with #225's consumers before the gate goes green
under the new value.

The bundle-size budget covers the runtime packages adopters ship
to production. `@causl/migration-check` itself is a build-time
CLI tool — its scanner bundle never reaches the adopter's
runtime, so it has no end-user-facing budget.

## Procedure

```bash
# Pre-migration baseline
git checkout main
pnpm test:run                         # capture: tests pass, count, durations
npx @causl/migration-check > drift-before.json

# Apply migrations following docs/migration/from-jotai.md (and others)

# Post-migration validation (every axis)
pnpm test:run                          # axis 2 — behaviour parity
npx @causl/migration-check > drift-after.json
                                       # axis 1 — drift-after.json has stats.findings === 0
grep -E '@causl/[a-z-]+-bridge' .   # axis 3 — must return empty
jq '.catalogueVersion' drift-after.json  # axis 4 — pinned schema version
```

Reproducing a CI fuzz failure: every parity-property failure
prints `CAUSL_FUZZ_SEED=<n> pnpm test:run`. Pass the env var
to your local invocation to replay the exact shrunk
counter-example.

## What this is NOT

- **Not a one-shot codemod.** The migration is human-supervised;
  the guides plus the drift detector are tools, not silver bullets.
  See `docs/migration/RULE_CATALOGUE.md` and the per-library
  `docs/migration/from-{jotai,mobx,redux}.md` guides.
- **Not a runtime bridge sign-off.** We deliberately do not ship a
  `@causl/jotai-bridge` package; the migration is forward-only
  per the team's commitment to deletable abstractions. Axis 3
  enforces this.

## Validation harness fixtures

Sample pre/post-migration codebases live in
`packages/migration-check/test/fixtures/`. Each fixture contains:

- `before/` — Jotai/MobX/Redux source with known patterns that
  the catalogue surfaces.
- `after/` — the human-supervised migration result. Imports
  causl APIs only.
- `expected-drift.json` — the `DriftReport`-equivalence contract
  the scanner must honour for `before/` (rule IDs, catalogue
  version, schema, minimum critical-severity count).

The harness in `test/fixtures.{before,after}.test.ts` runs the
scanner against every pair. The before/ harness asserts every rule
the contract names fires at least once; the after/ harness asserts
`findings.length === 0` and the no-bridge invariant.

Each new pre/post-migration fixture pair must:

1. Live under `packages/migration-check/test/fixtures/<library>/{before,after}/`.
2. Carry an `expected-drift.json` listing the rule IDs the before/
   tree must surface, the catalogue version, the schema, and the
   minimum critical-severity count.
3. Mirror the worked example in
   `docs/migration/from-{jotai,mobx,redux}.md` so the guides and
   the harness cannot drift apart.

## Status

- v0 (#199): doc + prose procedure.
- v1 (#225): runnable end-to-end. Fixtures, pinned environment,
  parity property at the SPEC §15.2 1000-trial floor, and
  machine-readable bundle and flake budgets are all landed.
