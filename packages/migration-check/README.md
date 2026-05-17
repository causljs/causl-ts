# `@causl/migration-check`

A static drift detector that scans a codebase for un-migrated
Jotai / MobX / Redux patterns and reports them by rule ID for CI
gating and migration dashboards.

```sh
npx @causl/migration-check ./src
```

The CLI prints a `DriftReport` JSON document and exits non-zero
if any findings are present.

## Canonical contract: `docs/migration/RULE_CATALOGUE.md`

The rule catalogue at
[`docs/migration/RULE_CATALOGUE.md`](../../docs/migration/RULE_CATALOGUE.md)
is the single source of truth for what this tool checks. It
defines:

- the rule ID format (`J-NN` Jotai, `M-NN` MobX, `R-NN` Redux/RTK,
  `S-NN` cross-source / causl-idiomatic),
- the per-rule schema (`status`, `severity`, `predicate`,
  `spec_ref`, `guide_section`, `detector_test`, etc.),
- the accepted allocations (J-01..J-09, M-01..M-06, R-01..R-06,
  S-01..S-09).

If you are adding or modifying a rule, allocate the rule ID in the
catalogue first, then add the predicate and the dedicated test
under this package, then update the worked example in the relevant
migration guide (`docs/migration/from-{jotai,mobx,redux}.md`). That
ordering is binding.

## How findings map to the migration guides

Each `DriftFinding` carries a `suggestion` pointing at the
relevant migration guide section. The guides
(`docs/migration/from-jotai.md`,
`docs/migration/from-mobx.md`,
`docs/migration/from-redux.md`) cite the same rule IDs in their
"before / after" examples, so the workflow is:

1. CI runs `causl-migration-check` on the project.
2. The report lists findings by rule ID and file:line.
3. The reviewer opens the guide for that rule ID and applies the
   worked example by hand.

There is **no codemod** and we do not plan to ship one. The
migration is hand-written under the catalogue's guidance.

## Status

This package was the seam between Epic F's three PRs (#197 guides,
#198 detector — this package, #199 validation procedure); all
three have merged, and the runnable end-to-end harness landed
under #225. The implementation is IR-driven (TypeScript compiler
API), per-rule predicates are tagged with the catalogue's
`RULE_ID` and `severity`, and every emitted `DriftReport` carries
a `catalogueVersion` so dashboards can refuse a report produced
under a schema they do not recognise.

Rule classes covered: J-01..J-09, M-01..M-06, R-01..R-06,
S-01..S-09. Each rule has at least one true-positive and one
true-negative fixture under `test/rule-{jotai,mobx,redux,cross}.test.ts`,
plus an alias-resilience pass under `test/predicates-fuzz.test.ts`.
The behaviour-parity property at
`test/properties/parity.property.test.ts` runs at the SPEC §15.2
1000-trial floor via the local `propertyOptions` helper in
`test/properties/seed.ts` — distinct from the cross-backend
fuzz-tier system (`resolveCrossBackendFuzzTier()` in
`packages/core/test/properties/seed.ts`, landed under PR #1097
closing #1073) that governs the wasm-bridge property suites.

## Default scan extensions

The directory walker filters by file extension. The default list is:

| Extension | Why it's in the default |
| --- | --- |
| `.ts` / `.tsx` | TypeScript source — the most common Jotai/MobX/Redux store format. |
| `.js` / `.jsx` | Plain-JavaScript stores — common in older codebases mid-migration. |
| `.mjs` | ESM-only entry points — common in pnpm workspaces that emit `.mjs` for the ESM build target. |
| `.cjs` | CJS-only modules — common in mixed-output monorepos and shim files. |

The catalogue's predicate contract is language-level
(`docs/migration/RULE_CATALOGUE.md`): a `createSlice` call in
`reducer.cjs` is the same rule (`R-01`) as one in `reducer.ts`. The
walker honours that by reading every common module-format
extension by default — otherwise a non-migrated reducer in `.cjs`
silently slips past the `findings.length === 0` axis of the
validation procedure (`docs/migration/validation.md`).

To narrow or widen the walk, pass `extensions` to the
programmatic API:

```ts
import { scanDirectory } from '@causl/migration-check'

// Default — scans .ts/.tsx/.js/.jsx/.mjs/.cjs
const full = await scanDirectory('./src')

// Narrow to TypeScript only
const tsOnly = await scanDirectory('./src', { extensions: ['.ts', '.tsx'] })
```

Extending the list is *not* a catalogue bump: `CATALOGUE_VERSION`
versions the rule schema, not the walker's reach.
