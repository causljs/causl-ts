# Contributing

## Local setup

```bash
git clone https://github.com/iasbuilt/causl
cd causl
pnpm install      # also installs the husky pre-commit hook
```

Node 24.x (matches `.nvmrc` and `.github/workflows/ci.yml`); `pnpm` >= 10.
Repo's `package.json#engines` pins `node >= 22` as a soft floor; CI and
local development run on 24. The Rust crate uses the stable toolchain —
install via `rustup`:

```bash
cargo build --release --manifest-path tools/checker/Cargo.toml
```

## Workflow

The repo is a workspace of TypeScript packages under `packages/` (the
canonical core, react, formula, sync, devtools, devtools-bridge,
persistence, checker, bench, hypothesis, migration-check, plus the
platform-specific `checker-*` shims and the `core-testing-internal`
seam) and Rust crates under `tools/` (`tools/checker/` ships
`causl-check`; `tools/enumerator/` ships `causl-enumerate`;
`tools/engine-rs-core/` carries the engine types that ship inside
`@causl/core`'s wasm-pkg artefacts; `tools/engine-rs-core-bench/`
hosts the JsonValue object-representation bench harness added under
#1162). The Rust engine port itself is **post-0.9.0** and deferred
behind GO/NO-GO criteria documented in epic
[#1133](https://github.com/iasbuilt/causl/issues/1133); contributors
adding code to `tools/engine-rs-core/` should read the epic body
before opening a PR.

Every change should:

1. **Land tests first.** The repo is TDD-aligned (Beck/Metz/Haines lineage
   in the team list). Failing test → implementation → green. Property
   tests (`fast-check`) sit in `test/properties/` and are gated on
   ≥1000 random cases.
2. **Pass the validate sweep.** `pnpm validate` runs typecheck + build
   + test:run across every package. The husky pre-commit hook runs the
   same; CI runs an additional Rust + checker-gate job.
3. **Stack PRs.** Sequential PRs based on each other (`feat/X` →
   `feat/Y` → `feat/Z`). Don't merge to `main` until the whole stack
   has been reviewed.

## Where to look

- **The repo-root specification** — the contract. The whole document
  is organised around five commitments — write down what a derived
  value *means* before how to compute one; treat every lifecycle as
  one composite statechart; keep the user's information model strictly
  separate from engine substrate and editor-controller state; collapse
  the taxonomy down to runnable single-digit concept counts; and ship
  the smallest thing that earns the right to grow. Every public-API
  change requires a pointer into the right section, or a patch to that
  section in the same PR.
- **`docs/semantics.md`** — the denotational definition. A `Behavior a`
  is `GraphTime → a`; a derived node at time `t` is a pure function of
  its inputs at the same `t`; a transaction creates exactly one new
  `t`. From those four lines glitch-freedom, determinism, and
  atomicity become theorems rather than scheduler tricks. If a change
  contradicts the denotational definition, the change is wrong.
- **`docs/lifecycle.md`** — the composite statechart. The engine
  collapses what would otherwise be five parallel string-enums (node
  status, resource fetch, transaction phase, conflict status,
  interaction mode) into one chart with hierarchy and orthogonal
  regions: Engine ∥ ResourceFleet ∥ ConflictRegistry. Every new
  Resource/Conflict transition must extend this chart, not append a
  parallel string-enum.
- **`docs/checker-coverage.md`** — what `causl-check` covers per
  release. The race-class catalogue is the table that says, for each
  class of race the engine can suffer, which mechanism catches it and
  at which layer (API design, compile-time, runtime, pre-deploy
  fuzz). The bounded model checker exists to lift runtime/fuzz rows
  into compile-time-equivalent CI gates; this doc is updated
  row-by-row when a catalogue line changes layer.

## Property-test reproductions

```bash
pnpm test:run                              # random seeds, default tier (1000 trials)
CAUSL_FUZZ_SEED=12345 pnpm test:run     # reproduce a CI failure
CAUSL_FUZZ_VERBOSE=1 pnpm test:run      # log per-run seeds
CAUSL_FUZZ_TIER=pr pnpm test:run        # PR tier (5000 trials)
CAUSL_FUZZ_TIER=nightly pnpm test:run   # nightly tier (100000 trials)
CAUSL_FUZZ_TRIALS=2500 pnpm test:run    # numeric override
```

The fast-check reporter prints the failing seed AND a copy-pasteable
re-run command. The tier system shipped in PR #1097 (issue #1073) and
was extended to every property test via the `tieredPropertyOptions` /
`tieredPropertyTrials` wrappers in PR #1163 (issue #1153); see
`packages/core/test/properties/seed.ts` and
`packages/core/testing/src/propertyTrials.ts`. New property tests
should route through these wrappers rather than hardcode `numRuns` at
the `fc.assert` callsite — the SPEC §15.2 conformance walker rejects
hardcoded literals.

## Style

- TypeScript strict on; `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`
  enforced. Use `T | undefined` (not `T?`) on optional fields you intend
  to assign with an undefined value.
- Tagged unions over optional fields. If a struct has `?value: T` and
  `?error: E`, replace it with `{kind: 'ok', value: T} | {kind: 'err',
  error: E}` — every "X may or may not have Y" optional field is a
  state-machine-in-disguise, and the engine commits to surfacing the
  tag rather than letting representations like "has a value AND an
  error AND no AST AND no dependencies" stay reachable. Make
  impossible states impossible.
- ESLint + Prettier config at the repo root; per-package `lint` script
  runs ESLint over the package's `src/` and `test/` only.
- No `void X` silencers. If a value is unused, don't capture it.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org). The
issue/PR numbers go in the body, not the subject:

```
feat: add staleness-policy guard

Closes #39

…
```

## Reviewer expectations

The repo uses the team-of-experts review pattern: every change should
be defensible to the team named in the project description (Beck,
Hejlsberg, Markbåge, Metz, Pocock, …). Concretely:

- **Semantics** — Conal Elliott pushback ("does this compose? what
  does it mean at one point in time?"). Land equations before code.
- **Statechart hygiene** — David Harel pushback ("is this a chart, or
  a parallel-enum hairball?"). Every status field must transition.
- **TypeScript discipline** — Matt Pocock pushback ("any `as` cast in
  here is paying interest"). Justify casts in comments.
- **Test design** — Kent Beck pushback ("does the test compare the
  implementation to itself?"). Keep external oracles where you can.

## Voice convention

The repo-root specification is written in first person — "I am the
engineer responsible for what ships." Every promise in the document
ties to a person making it; the eight commitments at the foot of the
spec are stated as "I will write down what a derived value *means*
before I write down how to compute one," "I will treat every lifecycle
as one composite statechart," and so on. The convention extends to:

- **PR descriptions.** Open in first person. State why you wrote this
  change, who pushed back, what you cut. The PR template seeds the
  shape.
- **Review comments.** First-person disagreements ("I think this
  belongs in the internal tier, not the load-bearing public surface,
  because …") read better than third-person imperatives.
- **CONTRIBUTING / docs prose.** Stay first person where the
  speaker is the team. Spec pointers and code comments may be
  imperative — those are contracts, not voice.

This is a soft convention, not a CI gate. The harder gate is below.

## The eight team commitments

The closing section of the repo-root specification states eight
commitments the team holds itself to: the semantic-foundation page
lands first, in code as well as prose, with every later decision
referencing it; the composite statechart is drawn before the conflict
and resource code is written; the model/controller/engine layering
is enforced at the package boundary; every discriminated union is a
*tagged* union with an exhaustiveness check the type system can
enforce; the race-class catalogue is kept current as the engine grows;
the worked example is the gate for "the engine is real"; no enum tags
ship whose transitions are not specified by the composite statechart;
and the bounded model checker ships as a required CI gate alongside
`tsc` and the property-based suite. The eight are enforced via a mix
of CI gates, lint rules, and human-review conventions; the table below
maps 1:1 to SPEC §17, row N to commitment N:

| # | Commitment (SPEC §17.N) | Enforcement |
| -- | ---------------------- | ----------- |
| 1 | The semantic-foundation page in §3 lands first; every later decision references it | Spec review (human) + `docs/semantics.md` cross-references in PR descriptions |
| 2 | The composite statechart in §6 is drawn before conflict and resource code | `docs/lifecycle.md` is updated in the same PR as any new conflict/resource transition; reviewer-enforced |
| 3 | Layering in §7 is enforced at the package boundary; `@causl/core` does not export controller types | Open today — tracked by [#393](https://github.com/iasbuilt/causl/issues/393) (no mechanical gate yet; lint rule or fitness function pending) |
| 4 | Every discriminated union in §9 is a *tagged* union with a type-system-enforced exhaustiveness check | [`assertNever`](packages/core/src/internal.ts) + `@typescript-eslint/switch-exhaustiveness-check` lint rule. See [Lint rules](#lint-rules) below |
| 5 | The race-class catalogue in §9.1 is kept current; every new public API arrives with a row in the table | Open today — tracked by [#399](https://github.com/iasbuilt/causl/issues/399) (PR-template anchor + CI gate pending) |
| 6 | The §10 worked example is the gate for "the engine is real" | `packages/core/test/spec-10-worked-example.test.ts` runs on every PR via `pnpm test:run` |
| 7 | No enum tags ship whose transitions are not specified by the §6 statechart | `docs/lifecycle.md` is the single source of truth for tag transitions; reviewer-enforced. Open instance tracked by [#380](https://github.com/iasbuilt/causl/issues/380) |
| 8 | `causl-check` (§16) ships as a required CI gate alongside `tsc` and the property suite | The `checker-gate` job in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) (modulo the v1/v1.x scope split tracked by [#386](https://github.com/iasbuilt/causl/issues/386)) |

### Other ship gates

The table above mirrors SPEC §17. The repo also ships gates that are not §17 commitments but are worth surfacing alongside them:

| Gate | Enforcement |
| ---- | ----------- |
| Public-surface size discipline on `Graph` | `packages/core/src/types.ts:Graph` and the `commitLog`/`snapshot`/`hydrate`/`readAt`/`snapshotAt` rows in the in-flight-additions tier — every addition is justified there |
| First-commit cycle detection | `packages/core/test/properties/cycle-completeness.test.ts` (1000 trials) |
| Property-test 1000-trial floor (per-property, every CI run, deterministic logged seeds) | `packages/core/test/spec-15.2-conformance.test.ts` meta-test |
| Naming-change discipline on every public-API rename/addition | `## Naming change` PR section + CI gate. See [Naming-change rule](#naming-change-rule) below |

### Naming-change rule

Any PR whose title starts with `feat:` / `feat(<scope>):` and which
adds or modifies a publicly-exported symbol from
`packages/*/src/index.ts` MUST include a `## Naming change` section in
the PR body listing every added / renamed / removed binding. The CI
gate `.github/workflows/pr-naming-rule.yml` enforces this — a missing
or `_None_`-only section fails the PR.

Worked examples:

- **Must FAIL** — `feat(core): add foo` adds `export const foo` to
  `packages/core/src/index.ts` with body `## Summary\nfoo`. No naming
  section → CI fails.
- **Must FAIL** — same diff, body has `## Naming change\n_None_`. The
  rule treats `_None_` as a lie when a public symbol was added.
- **Must PASS** — same diff, body has `` ## Naming change\n- Added
  `foo`: returns the answer to everything.``
- **Must PASS** — `chore: bump deps`, no `index.ts` changes. Rule
  doesn't apply.

The rule does not apply to `fix:` / `refactor:` / `test:` /
`chore:` / `build:` / `docs:` titles.

### Lint rules

- **`@typescript-eslint/switch-exhaustiveness-check`** (configured in
  `eslint.config.js` for `packages/*/src/**`). Any `switch` whose
  discriminant is a discriminated union must cover every variant or
  end with a `default: assertNever(x)` arm. Realises §17.4. The
  helper [`assertNever`](packages/core/src/internal.ts) lives under
  `@causl/core/internal` — adapter packages import from there.

- **`@typescript-eslint/no-explicit-any`** (error) — every `as any`
  cast is paying interest; if you need one, leave a `// why` comment
  in the same line.
