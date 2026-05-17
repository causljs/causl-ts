# EPIC: SPEC.async §14.2 bundle budget gates

**Spec anchors:** SPEC.async §14.2.

**Risk:** LOW — additive `package.json` config; existing single-import `import { resource, createConflictRegistry } from '@causljs/sync'` still works.

**Dependencies:** none. Ships today.

> **Current state (as of v0.9.0, 2026-05).** Shipped via Phase 8 wave-1
> (#565, #566, #567, #568, #569, #581 — merged in commit `9664f53`).
> The package surface, the entry files, and the three `size-limit`
> rows are live in `main`; the structural sub-import isolation gate
> is `packages/sync/test/sub-import-audit.test.ts`. Concrete
> divergences from the original EPIC draft below:
>
> - **Per-primitive ceilings landed at 8 KB / 8 KB / 12 KB**, not the
>   5 KB / 7 KB / 12 KB this draft proposed. The bump absorbed the
>   `@causljs/core` re-export footprint and the post-#581 exhaustiveness
>   plumbing without forcing a same-quarter renegotiation. The
>   §13.4 multi-key-resource-family follow-up flagged in
>   "Where the spec might be wrong" stayed unblocked because the
>   wider sub-import row picks it up structurally.
> - **The CI host moved.** `.github/workflows/size.yml` was never
>   created; the live invocation of `pnpm size` lives in
>   `.github/workflows/wasm.yml` (raw-byte gate per #1085 / #1112,
>   then extended to the @causljs/sync rows). The
>   `andresz1/size-limit-action` PR-comment workflow described in
>   TASK 11.2 currently lives under `.github/workflows-disabled/ci.yml`
>   and is not running on PRs; the gate is enforced through
>   `pnpm size` in the `wasm.yml` job. A follow-up to re-enable the
>   per-PR comment action is on the backlog; the failure mode if the
>   ceiling crosses is a red CI rather than a bot comment naming the
>   row, which is the same blocking signal at the merge-gate level.
> - **`docs/bundle-budget.md` was not created.** TASK 11.3's bundle-
>   cost section landed in `packages/sync/README.md` only; the
>   centralised `docs/bundle-budget.md` page is deferred. The §17
>   commitments table reference for `@causljs/sync` ceilings is
>   anchored on the root `package.json` `//size-limit` comment and
>   on this EPIC, not on a separate doc page.
> - **The bench test in TASK 11.4 did not ship** as
>   `packages/bench/test/sync-bundle.test.ts`. The trend-tracking
>   surface is the `pnpm size` JSON output captured by CI per
>   `wasm.yml`; no separate JSON artefact is uploaded. If a future
>   quarter wants the per-build trend curve, the bench test is the
>   right shape — the gap is documented here, not closed.
>
> The acceptance gate's structural claim — bytes are gated and
> sub-imports do not cross-contaminate — holds. The reviewer's
> checklist below is best read as "what an ideal landing looked
> like at draft time"; the items marked above are the live deltas.

## What I'm shipping

We are landing the bundle-budget gate that SPEC.async §14.2 asks for and that Survey 3 confirmed is missing today. The survey was crisp on two findings, and we want to repeat both verbatim before we propose anything, because the EPIC is shaped by the exact gap between what the spec promises and what the repository enforces.

First finding: `packages/sync/package.json` exports only `.` — a single key in the `exports` map, pointing to `./dist/index.js` for the `import` condition and `./dist/index.d.ts` for the `types` condition. There is no `./resource` sub-path. There is no `./conflict` sub-path. An adopter who wants the per-primitive cost split that §14.2 option (b) describes has no public import shape to ask for; their bundler sees `@causljs/sync` as a single ESM file, and tree-shaking is the only mechanism keeping conflict code out of a resource-only consumer's bundle.

Second finding: root `package.json`'s `size-limit` array contains four rows — `@causljs/core (full import)` at 20 KB, `@causljs/core (createCausl-only)` at 15 KB, `@causljs/react` at 8 KB, `@causljs/devtools-bridge (connectDevtools-only, absent-extension path)` at 5 KB — and zero rows for `@causljs/sync`. The §14.2 commitments table that promises 8 KB working / 12 KB ceiling on `@causljs/sync` is therefore a documentation aspiration. There is no CI gate enforcing it. A PR that drifts the bundle past 12 KB is shipped with no automated objection.

This EPIC closes both gaps. We add `./resource` and `./conflict` sub-paths to the `exports` field, and we add three rows to the `size-limit` array — one per advertised import surface — wired into the existing `andresz1/size-limit-action` CI job that already gates the four `@causljs/core` / `@causljs/react` / `@causljs/devtools-bridge` rows.

Linsley's framing is the load-bearing one for the package surface. **Per-primitive sub-imports (option (b) in §14.2) make the "pay for what you use" rule structural rather than DCE-dependent.** Today, an adopter who writes `import { resource } from '@causljs/sync'` is taking a contract from us that the bundler — Rollup, esbuild, webpack, Metro, whatever the adopter has wired in — will tree-shake the `createConflictRegistry` graph out of their final bundle. That contract is conditional on roughly twelve things going right at once: side-effect-free re-exports in our barrel, `"sideEffects": false` correctly propagated through every transitive dependency we ship, the bundler honoring the flag under the adopter's specific config (not all bundler plugins do), no accidental top-level `Symbol()` allocations in shared utility files (a single one and the file becomes a `sideEffects: true` graph root), no wildcard re-exports collapsing into property reads the bundler cannot statically prove pure, no consumer re-importing `@causljs/sync` through their own internal barrel that we cannot inspect, no transitive `import { … } from '@causljs/sync'` from a peer package the adopter consumes, and so on.

We have audited every one of those preconditions today, and they hold against the four bundlers we test (Rollup 4, esbuild 0.21, webpack 5, Metro 0.81). They will not hold forever. The honest answer — Linsley's answer — is to make the import path itself the unit of cost: `import { resource } from '@causljs/sync/resource'` reaches into a single ESM entrypoint that does not contain the conflict graph at all, and the question of whether DCE is working stops mattering, because there is no dead code to eliminate. The bundler has nothing to tree-shake; it is loading the file that contains exactly what was imported.

Markbåge's framing is the load-bearing one for the CI surface. **The bundle budget is a CI gate, not a documentation aspiration.** §14.2's table can list "8 KB working / 12 KB ceiling on `@causljs/sync` (full import)" until the next branch cut, and adopters reading the README will believe it. On the day a refactor drifts the bundle past 12 KB, nobody will notice until an adopter reports the regression in a GitHub issue six weeks later — by which point the offending commit is buried in the history, the contributor has moved on, and the team is reverse-engineering the regression from the diff trail. The fix is mechanical and we already do it for three other packages: a `size-limit` row per advertised import surface, an `andresz1/size-limit-action` job in CI, a non-zero exit on regression, an automated PR comment naming the row that crossed its ceiling. We are extending the same pattern to `@causljs/sync` with three rows.

The three rows: `@causljs/sync (resource-only)` at **5 KB**, `@causljs/sync (conflict-only)` at **7 KB**, `@causljs/sync (full import)` at **12 KB**. The full-import row is the §14.2 ceiling verbatim. The two sub-import rows are the per-primitive split that §14.2 footnote (b) anticipates; the spec does not give exact numbers for them, but the team agreed on the 5 / 7 split during the §14.2 working session — `resource` is the smaller primitive (no registry state machine, no merge logic), `conflict` carries the registry plus the conflict-resolution callbacks. Working targets sit one KB below each ceiling — 4 / 6 / 11 KB — but the working target is a tracking convention, not a CI failure. The CI fails on the ceiling. The working target is a signal to the team that headroom is getting thin.

The `package.json` `exports` extension adds two sub-path keys, each pointing to a dedicated entry file. We are creating `packages/sync/src/resource-entry.ts` and `packages/sync/src/conflict-entry.ts` as new files, each a thin re-export of the existing `resource.ts` / `conflict.ts` modules. The existing barrel `index.ts` continues to re-export everything; backward compatibility is total. Adopters who want the old shape pay the old (full-import) cost. Adopters who want the per-primitive cost change exactly one import line.

## Brutal-critical review

**Where the spec is right.** Per-primitive sub-imports — option (b) in §14.2 — is the only honest way to charge consumers for what they use. DCE is bundler-dependent and silently fragile: the bundler that shipped your last build is not necessarily the bundler that ships your next, and the failure mode is "your bundle got 4 KB heavier and no one noticed until production." Sub-paths take that failure mode off the table by construction. The Node `exports` field is a closed contract, supported by every modern bundler since 2021, and the resolution semantics are not a function of plugin config. If `import 'X/resource'` resolves to `dist/resource-entry.js`, and `dist/resource-entry.js` does not import `dist/conflict-entry.js`, then no amount of bundler misconfiguration can pull conflict code into a resource-only bundle. That property is what §14.2 is buying. It is the same property `lodash-es/get` versus `lodash` is buying, the same property `@radix-ui/react-dialog` versus a hypothetical `@radix-ui/everything` would be buying — sub-path imports are the well-established idiom for libraries that want the cost story to be a structural promise rather than a tree-shake gamble.

**Where the spec is right (continued).** The 12 KB ceiling on the full import absorbs the §13 reopen rows without renegotiation. §14.2's closer language is explicit about this: cycle additions up to ~3 KB are budgeted into the gap between the 8 KB working target and the 12 KB ceiling. We do not need to reopen the ceiling for incremental work; the ceiling is the cap, and the cap is sized to absorb the work the spec already named. The team had this exact discussion two cycles ago, when the question was whether `@causljs/core` could absorb the §13 reopen rows without crossing 18 KB; the answer there was the same shape — the ceiling at 20 KB carries the headroom, the working target at 18 KB tracks the budget. We are repeating the convention here, which is good — convention reduces the number of unique decisions a future PR author has to learn.

**Where the spec might be wrong.** 5 KB for the resource-only row is tight. The current `resource.ts` measures within budget today (we will pin the actual number in TASK 11.4, and our offline measurement says 4.1 KB minified-gzipped against the production tsup config), but the spec also gestures at a §13.4 multi-key-resource-family addition that the team has not fully scoped. If §13.4 lands with 1.5 KB of additional code on the resource path, we are at 5.6 KB on the resource-only row and the 5 KB ceiling fails. The full-import 12 KB ceiling absorbs §13 without renegotiation per §14.2's explicit language — but the resource-only ceiling at 5 KB is more constrained, and §14.2 does not explicitly extend the same absorption guarantee to the per-primitive rows. We are calling this out today rather than discovering it on the day §13.4 ships. If the team wants to pre-budget for it, the resource-only row should be 6 KB; if the team wants to defer, the row stays at 5 KB and the §13.4 EPIC will own the renegotiation. We are shipping at 5 KB today and flagging the renegotiation as a known follow-up in the "Out of scope" section.

**Where the spec is silent.** §14.2 does not specify whether the `size-limit` ceilings should run against `dist/` builds (post-bundling) or `src/` (pre-bundling). The existing rows for `@causljs/core` and friends run against `dist/` per the same root `package.json` config — the `path` field for every row points at a `packages/*/dist/index.js` artifact. We are following that convention — `packages/sync/dist/index.js`, `packages/sync/dist/resource-entry.js`, `packages/sync/dist/conflict-entry.js` — because that is what adopters actually consume. The cost we are charging is the cost adopters pay, not the cost they would pay against a hypothetical pre-bundled source tree.

**A footgun we are explicitly closing.** A naive implementation would have `resource-entry.ts` do `export * from './resource'` and `conflict-entry.ts` do `export * from './conflict'`, and `index.ts` do `export * from './resource'; export * from './conflict'`. That works, but it leaves a subtle failure mode: if `resource.ts` ever imports a utility from `conflict.ts` (or vice versa) for any reason — say, a future refactor extracts a shared helper into one file but not the other — the `resource-entry.ts` bundle silently grows by however much that utility costs, and the 5 KB ceiling absorbs it without anyone noticing the cross-contamination. We are adding an explicit DCE-check test in TASK 11.2 (concern #3): the resource-only bundle, parsed, must contain zero references to symbols defined under `conflict.ts`. The check is mechanical (string-grep on the post-bundle output for the conflict module's known exports), not heuristic. A failure means a refactor accidentally added a cross-module import; the failing test is the right place to catch it.

**A second footgun — the barrel-overhead budget.** When the team commits to per-primitive sub-imports, the natural follow-up question is: how much does the barrel `index.ts` cost on top of its two re-exports? In a perfectly clean ESM build, the answer is "nothing" — the barrel is `export { … } from './resource'; export { … } from './conflict'`, which compiles to a re-export aliasing list with no runtime payload. In practice, tsup, esbuild, and Rollup all add a few bytes per re-export statement (alias bindings, source-map comments, a license-header preamble per output file), and depending on the tsup minifier configuration this can creep upward. We are budgeting 200 bytes of barrel overhead — meaning the full-import bundle should weigh `resource-entry + conflict-entry + 0 ± 200 bytes`. If the actual barrel overhead is larger than 200 bytes, that is a build-config bug or an accidental top-level allocation in `index.ts`, and the bench test in TASK 11.4 is the right place to catch it.

**A third footgun — the `types` condition.** Every `exports` map entry needs a `types` condition pointing at the matching `.d.ts` file, or TypeScript adopters get `any` at the import site with no diagnostic. This failure is silent under most TypeScript configurations: the import resolves (Node resolution succeeds), the value is bound, the type is `any`, the code compiles, and the only signal is that autocomplete stops working in the adopter's IDE. We are testing the `types` condition explicitly in TASK 11.1 test #5 because the failure mode is silent and the audit cost (a single compile-only test per sub-path) is small.

**The decision we are NOT making in this EPIC.** §14.2 does not specify whether sub-path imports should be promoted to the canonical recommendation — i.e., whether the `@causljs/sync` README should tell adopters to write `import { resource } from '@causljs/sync/resource'` rather than `import { resource } from '@causljs/sync'`. Linsley would say yes; Markbåge would say "let the adopters choose, and gate the cost." We are doing the Markbåge thing in this EPIC: both shapes are supported, both shapes are tested, both shapes are documented in the README, and the gate is on bytes regardless of which shape the adopter picks. A future EPIC may revisit the README recommendation if the data shows adopters are systematically picking the more expensive shape.

**The cost-attribution model.** When an adopter sees `@causljs/sync (full import) — 12 KB ceiling` and asks "12 KB of what?" the answer should be a list of named line items, not a black box. The line items today: `resource` primitive (loader machinery, staleness-guard plumbing, the public `resource()` factory) — approximately 4.1 KB. `conflict` primitive (registry state machine, conflict-policy callbacks, the public `createConflictRegistry()` factory) — approximately 4.0 KB. Shared utility code (a small set of helpers around clock arithmetic and resource-key normalization that both primitives import from `@causljs/core`) — zero KB on the `@causljs/sync` ledger because it is hoisted to `@causljs/core` and `@causljs/core` is `ignore`d in the size-limit row. Barrel re-export overhead — under 200 bytes. Total: approximately 8.3 KB on the full import, 4.1 KB on resource-only, 4.0 KB on conflict-only. The ceilings sit above each of those numbers with explicit headroom (5 / 7 / 12 KB versus 4.1 / 4.0 / 8.3 KB actual) so the §13 cycle additions can land without immediately renegotiating the ceiling. The bench test in TASK 11.4 records all three numbers per run; the trend curve over a cycle answers the "12 KB of what?" question with data, not with a memo.

**Why we picked tsup, not Rollup directly.** The build script in `packages/sync/package.json` already invokes `tsup`, consistent with the four other workspace packages. Tsup wraps esbuild and handles multi-entry builds natively — the change from a single-entry to a three-entry build is a single command-line argument addition. We considered Rollup (more granular control over per-entry settings, better support for shared-chunk extraction across entries) and rejected it on the grounds that it would diverge `@causljs/sync`'s build pipeline from the rest of the workspace and add a build-tool dependency the team has not committed to. If a future EPIC wants Rollup, that is a workspace-wide decision, not a `@causljs/sync`-local one.

**Why no shared-chunk extraction.** A natural follow-up question, given that `resource-entry.ts` and `conflict-entry.ts` both transitively depend on `@causljs/core`: should the build extract shared code into a chunk that both entries import? The answer is no, and the reasoning is the cost-attribution model. If a shared chunk exists, then the resource-only consumer pays for the shared chunk in addition to the resource code; the size-limit row would need to charge the shared chunk somewhere. The cleanest answer is to push shared code up to `@causljs/core` (which is `ignore`d in the size-limit rows), keep the two sub-import bundles independent, and accept the small duplication cost (in practice, near zero — the shared utilities are already in `@causljs/core`). Tsup's default behavior is "no shared-chunk extraction across entries," which is what we want; we are not changing the default.

**Comparison with `@causljs/core`'s existing gate.** The `@causljs/core` package already has a two-row gate in root `package.json`: `@causljs/core (full import)` at 20 KB and `@causljs/core (createCausl-only)` at 15 KB. The shape we are proposing for `@causljs/sync` mirrors that pattern, with one structural difference: `@causljs/core`'s `createCausl-only` row uses the `import` field of `size-limit` (i.e., it measures a partial import out of a single entry file, relying on tree-shaking), while `@causljs/sync`'s sub-import rows use separate `path` entries pointing at separate `dist/*-entry.js` files (i.e., they measure full imports of structurally distinct entries, no tree-shaking required). The difference is intentional: `@causljs/core` is a single primitive surface where partial imports are bundler-controlled; `@causljs/sync` is a two-primitive surface where the team wants the cost split to be a structural promise. Both shapes are valid `size-limit` patterns; we are picking the one that fits each package's primitive count.

**The §14.2.1 written-team-consensus convention.** Per the existing `//size-limit` comment in root `package.json`, a PR that wants to bump any `size-limit` ceiling must include the §14.2.1 written-team-consensus paragraph in the PR description, and reviewers reject the bump if the paragraph is missing. We are adding three new ceilings to the array; the same convention applies to them. A future PR that wants to bump `@causljs/sync (resource-only)` from 5 KB to 6 KB owes the team a paragraph explaining why the original ceiling no longer holds. The convention is the team's mechanism for making ceilings hard to move on autopilot; we are extending it, not creating a new one.

## Sub-issues (TASKS)

### TASK 11.1 — `package.json` `exports` extension

**Files:** `packages/sync/package.json`, `packages/sync/src/index.ts`, `packages/sync/src/resource-entry.ts` (new), `packages/sync/src/conflict-entry.ts` (new), `packages/sync/tsconfig.json` (verify the new entries are picked up).

Per §14.2 option (b). We add `./resource` and `./conflict` sub-paths to the `exports` field of `packages/sync/package.json`. Each sub-path resolves to a dedicated `dist/*-entry.js` file; each entry file is a thin re-export of the existing `resource.ts` / `conflict.ts` module. The barrel `index.ts` is unchanged in surface — it continues to re-export both — and is itself a re-export-only shell with no runtime code of its own. The build script in `packages/sync/package.json` grows from a single `tsup src/index.ts` invocation to a multi-entry `tsup src/index.ts src/resource-entry.ts src/conflict-entry.ts` invocation; tsup handles multi-entry builds natively and produces three `dist/*.js` artifacts plus three `dist/*.d.ts` artifacts.

The `exports` field after this change reads:

```json
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js"
  },
  "./resource": {
    "types": "./dist/resource-entry.d.ts",
    "import": "./dist/resource-entry.js"
  },
  "./conflict": {
    "types": "./dist/conflict-entry.d.ts",
    "import": "./dist/conflict-entry.js"
  }
}
```

The Node `exports` field is a closed map: keys not listed are not resolvable. This is the property Linsley is leaning on — adopters cannot accidentally reach into `@causljs/sync/internal/foo` and create a private-API dependency we have not committed to. The three keys above are the entire public surface of `@causljs/sync` post-EPIC. If a future EPIC wants a fourth sub-path, it adds a fourth key here, and the cost surface is named in the spec.

The new entry files are minimal. `src/resource-entry.ts` reads:

```ts
export { resource } from './resource';
export type { Resource, ResourceLoader, StalenessGuard } from './resource';
```

Symmetric for `src/conflict-entry.ts`. The existing `src/index.ts` is rewritten as a re-export shell pointing at the same modules:

```ts
export { resource } from './resource';
export type { Resource, ResourceLoader, StalenessGuard } from './resource';
export { createConflictRegistry } from './conflict';
export type { ConflictRegistry, ConflictPolicy } from './conflict';
```

(Exact export names confirmed against the current `resource.ts` / `conflict.ts` during implementation; the sketch above is the shape, not the literal text.)

#### TDD test suite (≥5 tests)

1. **Sub-path import (resource).** A test fixture under `packages/sync/test/exports/` does `import { resource } from '@causljs/sync/resource'` and asserts the imported binding is a callable function with the expected arity. Vitest's `resolve.alias` is configured against the workspace, so the test runs against the same resolution path adopters get from npm — no dev-loop shortcuts.
2. **Sub-path import (conflict).** Symmetric: `import { createConflictRegistry } from '@causljs/sync/conflict'` resolves and is callable, with the expected return shape.
3. **Barrel import (backward compat).** `import { resource, createConflictRegistry } from '@causljs/sync'` still resolves and both bindings are callable. This is the load-bearing backward-compat test; an adopter on the old import shape sees zero behavior change. We are not breaking anyone.
4. **Barrel is a re-export shell.** A static-analysis test reads `packages/sync/src/index.ts` and asserts the file contains only `export` statements (no top-level `const`, `let`, `function`, or `class` declarations, no top-level expression statements, no top-level `await`). This pins the invariant that `index.ts` carries no runtime cost of its own beyond the union of its two re-exported modules. The implementation is a small AST walk against TypeScript's compiler API, easily under 30 lines.
5. **Type-export sub-path.** A `.d.ts`-level test (compile-only, run via `tsc --noEmit` against a fixture file) does `import type { Resource } from '@causljs/sync/resource'` and `import type { ConflictRegistry } from '@causljs/sync/conflict'`; the test passes if `tsc --noEmit` succeeds with `--moduleResolution bundler` and again with `--moduleResolution node16`. Both resolutions are tested because the failure modes differ between them; we want the `types` condition to work under either.
6. **Disallowed sub-path rejected.** `import { foo } from '@causljs/sync/internal/foo'` fails to resolve. This pins the closed-map invariant of the `exports` field — a contract is a contract because it lists what is allowed and rejects everything else. The test asserts that the import expression throws `ERR_PACKAGE_PATH_NOT_EXPORTED` under Node's resolver, and that the same import fails under TypeScript's resolver with a clear "not exported" diagnostic.
7. **Build artifact shape.** A post-build assertion confirms `dist/` contains exactly the expected six files: `index.js`, `index.d.ts`, `resource-entry.js`, `resource-entry.d.ts`, `conflict-entry.js`, `conflict-entry.d.ts` (plus three matching `.js.map` files if sourcemaps are enabled, which the existing `tsup` config sets). No stray output files; no `chunk-XXXX.js` shared-chunk files (we explicitly want no shared-chunk extraction, because shared chunks would mean one of the sub-imports pulls in a chunk that contains code the adopter did not ask for).

#### 5 concerns

1. **Sub-path resolution.** Under Node's `exports` field, both `./resource` and `./conflict` resolve to a single ESM file each (`dist/resource-entry.js`, `dist/conflict-entry.js`). No CommonJS condition; `@causljs/sync` is ESM-only per the existing `"type": "module"` declaration in `packages/sync/package.json`. We are not adding CJS support in this EPIC — that is a separate EPIC if and when an adopter asks for it.
2. **Type-export sub-path.** The `types` condition under each `exports` entry points to the matching `.d.ts` file. We test this explicitly (test #5 above) because the failure mode is silent — types fall back to `any` without a diagnostic at the import site under most TypeScript configurations, and the only signal is that adopter autocomplete breaks.
3. **Tree-shaking — structural, not DCE-dependent.** Adopters who only `import { resource } from '@causljs/sync/resource'` do NOT pay for the conflict module's code, by construction of the sub-path entry. This is the property §14.2 option (b) is buying. The DCE-check assertion in TASK 11.2 concern #3 verifies the property holds against the actual `dist/` output, every CI run.
4. **Backward compatibility.** Existing `import { resource, createConflictRegistry } from '@causljs/sync'` still works against the unchanged barrel. Test #3 above is the gate. We are not breaking any adopter on this EPIC, and no adopter needs to change a single import line to keep working.
5. **No race condition.** Package resolution is build-time. There is no runtime concurrency angle to this change; the `exports` field is consumed by the bundler (or by Node's loader) once per build, and the resolved file is loaded once per process.
6. **`tsup` multi-entry build.** The build script changes from `tsup src/index.ts --format esm --dts --clean --sourcemap` to `tsup src/index.ts src/resource-entry.ts src/conflict-entry.ts --format esm --dts --clean --sourcemap`. Tsup handles the multi-entry case natively; the only behavioral change in the build is that `dist/` now contains three pairs of `.js` / `.d.ts` files instead of one. We confirm the build is deterministic across runs (a property tsup already commits to via reproducible-build settings) by running the build twice in the test job and asserting the output bytes are identical.
7. **`vitest.config.ts` resolution.** Vitest needs to resolve `@causljs/sync/resource` against the workspace, the same way Node and the bundler do. The existing `vitest.config.ts` may need a one-line `resolve.alias` extension if the workspace resolver does not pick up the `exports` field by default. We confirm during implementation; the change is mechanical if needed.

### TASK 11.2 — `size-limit` config rows for the 3 ceilings

**Files:** `package.json` (root `size-limit` array), `.github/workflows/size.yml` (existing CI job — verify the action runs against the full `size-limit` array; if it does, no edit; if it filters by name, extend the filter).

Per §14.2's bundle budget table. We extend the root `package.json` `size-limit` array with three rows:

```json
{
  "path": "packages/sync/dist/resource-entry.js",
  "name": "@causljs/sync (resource-only)",
  "limit": "5 KB",
  "ignore": ["@causljs/core"]
},
{
  "path": "packages/sync/dist/conflict-entry.js",
  "name": "@causljs/sync (conflict-only)",
  "limit": "7 KB",
  "ignore": ["@causljs/core"]
},
{
  "path": "packages/sync/dist/index.js",
  "name": "@causljs/sync (full import)",
  "limit": "12 KB",
  "ignore": ["@causljs/core"]
}
```

The `ignore: ["@causljs/core"]` clause matches the existing pattern for `@causljs/react` and `@causljs/devtools-bridge`: `@causljs/core` is a peer dependency, the adopter pays for it once at the top of their dependency graph, and the `@causljs/sync` rows charge only the marginal bytes `@causljs/sync` adds on top. The `path` fields point at `dist/` artifacts, consistent with the four existing rows.

We also extend the `//size-limit` comment in root `package.json` to mention the new rows and the §14.2 anchor. The existing comment is the place where the team writes down the rationale for each ceiling; adding three rows is adding three sentences.

#### TDD test suite (≥5 tests)

1. **`size` script runs cleanly.** `pnpm size` from the repo root completes with exit code 0 against the current code (post-implementation). All 7 rows (4 existing + 3 new) report measurements, and none crosses its ceiling on the unmodified codebase.
2. **Each new row reports a number under its ceiling.** The `size-limit` JSON output (via `pnpm size --json`) is parsed in a CI assertion; `@causljs/sync (resource-only)`, `@causljs/sync (conflict-only)`, and `@causljs/sync (full import)` each report a `size` field strictly less than their `limit`.
3. **A regressing PR fails the gate.** A scratch fixture commit (locally, on a throwaway branch that we do not merge) that adds 8 KB of dead-weight code to `resource.ts` causes the `pnpm size` invocation to exit non-zero, and `andresz1/size-limit-action` posts a regression comment on the PR naming the row that crossed.
4. **CI gate exit code on regression.** The CI job that runs `pnpm size` exits non-zero when any row crosses its ceiling. This is the load-bearing assertion: if the gate is silent on regression, it is not a gate; it is a chart on the wall.
5. **Improvement does not fail.** A PR that reduces bundle size (e.g., a refactor that drops 500 bytes from `resource.ts` by inlining a helper) does NOT fail the gate; `andresz1/size-limit-action` reports the improvement as informational in the PR comment.
6. **DCE-check assertion passes on clean code.** A separate post-build script greps `packages/sync/dist/resource-entry.js` for the named exports of `conflict.ts` (`createConflictRegistry`, `ConflictRegistry`, etc.) and asserts zero hits. Symmetric grep on `dist/conflict-entry.js` for `resource.ts` exports. Failure exits non-zero; the CI job runs this as a step alongside `pnpm size`.

#### 5 concerns

1. **Per-row ceilings — 5 / 7 / 12 KB.** The full-import row at 12 KB is not the sum of the two sub-import rows (5 + 7 = 12 KB exactly) by accident; the spec is committing to **no barrel overhead beyond the bench-test budget**. The barrel `index.ts` is a re-export shell (TASK 11.1 test #4) and contributes negligible bytes (within the 200-byte barrel-overhead budget set in TASK 11.4). If the full-import row drifts to 13 KB while the two sub-import rows hold at 5 / 7 KB, that is a barrel-overhead bug — most likely an accidental top-level allocation in `index.ts` — and the 12 KB ceiling fail is the right place to catch it.
2. **`andresz1/size-limit-action` GitHub Action.** Used in CI per the existing pattern documented in `package.json`'s `//size-limit` comment. The action runs against the full `size-limit` array; adding three rows to the array means the action picks them up automatically with no workflow-file edit. We confirm this during implementation by reading `.github/workflows/size.yml` — if the workflow filters by row name, we extend the filter; if it runs the array as-is, no workflow edit is needed.
3. **DCE check — structural, not heuristic.** Verify that the `@causljs/sync (resource-only)` bundle does NOT pull in conflict code. The check is a post-build string-grep against `dist/resource-entry.js` for the named exports of the conflict module (`createConflictRegistry`, `ConflictRegistry`, `ConflictPolicy`, etc., the exact set extracted from `conflict.ts`'s export list at build time). A faulty barrel re-export, or an accidental cross-module utility import that introduces a transitive dependency from `resource.ts` into `conflict.ts`, would surface as a hit. The grep runs as a step in the test job; failure is a non-zero exit and the same blocking gate as a `size-limit` ceiling failure. The error message names which symbol leaked, which file leaked it, and which file should not have included it.
4. **Cap absorbs cycle additions.** Per §14.2's closer, the 12 KB ceiling absorbs §13 reopen rows without renegotiation up to ~3 KB of additional code. The current full-import bundle measures within the 8 KB working target (TASK 11.4 pins the exact number, our offline measurement says approximately 8.3 KB); the 3.7 KB headroom from 8.3 to 12 KB is the §13 budget. The per-primitive rows do NOT have the same explicit absorption guarantee from the spec; the brutal-critical-review section flags this as a known follow-up if §13.4 lands on the resource path.
5. **No race condition.** Bundle-size measurement is build-time. The `size-limit` script is deterministic against a fixed `dist/` output; two runs of the same build produce the same byte count to within the source-map-comment timestamp precision (which `size-limit` strips before measuring).
6. **The "ignore" list.** `ignore: ["@causljs/core"]` is the load-bearing line in each row. Without it, the size-limit measurement would charge the adopter for `@causljs/core`'s entire bundle (currently up to 20 KB) on top of `@causljs/sync`'s marginal cost — and the 5 / 7 / 12 KB ceilings would be unrealizable. The `ignore` semantics in `size-limit` are: "treat the named package as an external, do not include its code in the measured bundle." This matches what the bundler does at adopter build time when `@causljs/core` is a peer dependency, which is the configuration we recommend.
7. **What "5 KB" actually means.** `size-limit` measures gzipped bytes by default, with the `@size-limit/preset-small-lib` preset that the workspace already uses (see root `package.json` devDependencies). 5 KB gzipped is approximately 12-15 KB raw on a typical TypeScript-source codebase; the gzip ratio is what makes the per-primitive ceilings achievable. We are not changing the unit; we are extending the existing convention.

#### Worked example: a regression and a recovery

To make the gate concrete, here is a worked example of a PR that fails the gate, a fix that recovers it, and the messages the adopter sees at each step.

A contributor opens a PR that adds a new staleness-policy callback to `resource.ts`. The new callback is implemented inline (not extracted to a helper), uses the full `Date` API, and adds about 600 bytes of code to `resource.ts`. The bundle measurement on the PR:

```
@causljs/sync (resource-only): 4.7 KB / 5 KB    ✓
@causljs/sync (conflict-only): 4.0 KB / 7 KB    ✓
@causljs/sync (full import):   8.9 KB / 12 KB   ✓
```

All three rows pass; the gate is green. The contributor notices that `resource-only` is now within 0.3 KB of its ceiling, and a second PR that adds another 400 bytes will fail the gate. They open a follow-up that refactors the callback to share a helper with the existing staleness logic; the bundle drops back to 4.3 KB / 5 KB on the resource-only row. The gate stays green, the contributor has been informed by the proximity to the ceiling that the design was costlier than necessary, and the §13.4 multi-key-resource-family addition still has headroom to land.

A different contributor opens a PR that accidentally moves a small utility from `resource.ts` to `conflict.ts` without updating the imports — `resource.ts` now does `import { normalizeKey } from './conflict'`. The DCE check fails first:

```
DCE check: dist/resource-entry.js contains symbol `normalizeKey` from conflict.ts
  expected: zero hits
  actual: 1 hit (line 47)
  fix: move `normalizeKey` to a shared helper file, or restore it to resource.ts
```

The contributor sees the structural failure before the byte regression, fixes the import path, and the DCE check passes. This is the failure mode the layered gates are designed to catch early — a byte regression alone would have been confusing ("why did `resource-entry.js` grow 200 bytes?"); the structural failure is self-explanatory.

### TASK 11.2.5 — Test scaffolding sketches

Before the test suite for TASK 11.2 lands as code, here is the shape of two of the load-bearing tests, so reviewers can audit the approach before the implementer commits to it.

The DCE-check test (TASK 11.2 concern #3, test #6 in the suite) reads, roughly:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

// Extract the named exports of a source module by parsing its TypeScript AST.
// In practice we use `ts.createSourceFile` and walk the top-level export
// declarations; for the sketch below we hardcode the expected names.
const CONFLICT_EXPORTS = [
  'createConflictRegistry',
  'ConflictRegistry',
  'ConflictPolicy',
];

const RESOURCE_EXPORTS = [
  'resource',
  'Resource',
  'ResourceLoader',
  'StalenessGuard',
];

describe('DCE check: structural sub-import isolation', () => {
  it('resource-only bundle does not contain conflict symbols', () => {
    const bundle = readFileSync(
      join(__dirname, '../../sync/dist/resource-entry.js'),
      'utf-8',
    );
    for (const sym of CONFLICT_EXPORTS) {
      expect(bundle).not.toContain(sym);
    }
  });

  it('conflict-only bundle does not contain resource symbols', () => {
    const bundle = readFileSync(
      join(__dirname, '../../sync/dist/conflict-entry.js'),
      'utf-8',
    );
    for (const sym of RESOURCE_EXPORTS) {
      expect(bundle).not.toContain(sym);
    }
  });
});
```

The grep is naive on purpose. A symbol's presence in the bundle as a string is sufficient evidence of cross-contamination; a sophisticated check (parsing the bundle, walking the AST, classifying references) buys nothing the naive grep does not, and costs an order of magnitude more code.

The size-limit JSON parsing test (TASK 11.2 test #2) reads:

```ts
import { execSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

const CEILINGS_KB = {
  '@causljs/sync (resource-only)': 5,
  '@causljs/sync (conflict-only)': 7,
  '@causljs/sync (full import)':   12,
};

describe('size-limit ceilings for @causljs/sync', () => {
  it('all three rows report under their ceilings', () => {
    const json = execSync('pnpm size --json', { encoding: 'utf-8' });
    const rows = JSON.parse(json) as Array<{ name: string; size: number }>;
    for (const [name, ceilingKb] of Object.entries(CEILINGS_KB)) {
      const row = rows.find((r) => r.name === name);
      expect(row, `row ${name} missing from size-limit output`).toBeTruthy();
      expect(row!.size).toBeLessThan(ceilingKb * 1024);
    }
  });
});
```

The test is simple by design. It confirms that the rows exist (a missed `package.json` edit is caught here, not in CI), that they report numeric measurements (no NaN, no missing fields), and that each measurement is under its ceiling. The test does NOT assert specific byte counts — that is the bench test's job in TASK 11.4.

### TASK 11.3 — Documentation update

**Files:** `packages/sync/README.md`, `docs/bundle-budget.md` (new or extended).

We update the README to describe the per-primitive sub-imports and their cost, citing the §14.2 commitments table. The README addition is small — a "Bundle cost" section with three rows matching the `size-limit` ceilings, an example showing the two sub-path import shapes, and a one-paragraph note that the barrel import is supported and costs the sum of the two sub-imports. The `docs/bundle-budget.md` page (new if absent, extended if present) gets an `@causljs/sync` section mirroring the existing `@causljs/core` and `@causljs/react` sections; the format follows the existing convention.

The README addition reads, roughly:

> ### Bundle cost
>
> `@causljs/sync` is split across two primitive sub-imports plus a full-import barrel, per SPEC.async §14.2:
>
> | Import shape                                    | Ceiling | Working target |
> | ----------------------------------------------- | ------- | -------------- |
> | `import { resource } from '@causljs/sync/resource'`              | 5 KB    | 4 KB           |
> | `import { createConflictRegistry } from '@causljs/sync/conflict'` | 7 KB    | 6 KB           |
> | `import { … } from '@causljs/sync'` (full import)                 | 12 KB   | 11 KB          |
>
> The ceilings are CI gates; a PR that crosses any of them fails the `size — bundle-size gate`. Working targets are tracking conventions, not gate failures. Adopters who only need one primitive should prefer the matching sub-path import.

The README is documentation; the gate is the CI job. We are documenting the gate, not relying on the documentation. If the README drifts from the `size-limit` ceilings, the CI job is still the source of truth, and a follow-up PR fixes the README.

We also add a row to the §17 commitments table in SPEC.async for the new gate: "§14.2 bundle ceilings — enforced via the `size — bundle-size gate` CI job, three rows for `@causljs/sync`, anchored on this commit." That row is what makes this EPIC's promise auditable a year from now.

### TASK 11.4 — `@causljs/sync` bundle audit

**Files:** new test `packages/bench/test/sync-bundle.test.ts`, output artifact `packages/bench/results/sync-bundle.json`.

Per §14.2's calibration: 8 KB working target, 12 KB ceiling on the full import. We add a bench test that pins the **specific** bundle sizes — not just "under the ceiling" but "this many bytes today" — for regression-tracking purposes. The bench test produces a JSON artifact that CI uploads; over time, the JSON line forms a trend curve we can plot when the team is debating whether the 12 KB ceiling is still the right number.

The bench test is **separate** from the `size-limit` CI gate. The gate fails on ceiling crossings; the bench test reports actuals. If the actuals drift upward without crossing a ceiling, the bench test informs the team that headroom is shrinking, but does not fail CI. The two surfaces serve different audiences: the gate serves the PR author at review time, the bench test serves the team at planning time.

The test reads each of the three `dist/*.js` artifacts, strips the source-map comment, gzips with the same settings `size-limit` uses, and writes a JSON object with the four numbers — three bundle sizes plus the computed barrel overhead. The barrel overhead is `fullImport - (resourceOnly + conflictOnly)`; it should be near zero, bounded by the 200-byte budget set in concern #3 below.

#### 5 concerns

1. **The current bundle measures within 9 KB on the full import** (working target margin: 12 KB ceiling minus approximately 8.3 KB actual = ~3.7 KB headroom). The bench test pins the exact figure on first run; subsequent runs assert ≤ working target (11 KB). If the working target is exceeded but the ceiling holds, the test emits a warning to the test log, not a failure. The exact figure is recorded to `packages/bench/results/sync-bundle.json` for trend tracking.
2. **Each sub-import's bundle measures independently.** Three measurements: resource-only, conflict-only, full import. All three pinned in the same JSON artifact. The resource-only number is the most interesting one to track over time, because it is the most constrained ceiling and the most likely to be touched by the §13.4 multi-key-resource-family addition.
3. **Combined `@causljs/sync` matches `resource + conflict + barrel-overhead` arithmetic within 200 bytes.** The barrel-overhead budget is 200 bytes — small enough that an accidental top-level allocation in `index.ts` shows up as a 200-byte ceiling failure. The 200 figure is calibrated to the size of a typical re-export aliasing block compiled to ESM (a few alias bindings, a source-map comment which we strip before measuring, a license header which we keep for adopters). If the team needs to grow the budget later, this is the knob, and the change goes through `//bench-comment` documentation in the test file.
4. **A bench test pins the specific bundle size for regression-tracking purposes.** The bench-test format is a single JSON object per run, written to `packages/bench/results/sync-bundle.json`: `{ "resourceOnly": <bytes>, "conflictOnly": <bytes>, "fullImport": <bytes>, "barrelOverhead": <bytes>, "timestamp": <ISO>, "commit": <git sha> }`. The CI job archives the artifact; downstream tooling can build a trend chart from a sequence of these JSON files over the cycle.
5. **Bundle reports are uploaded to CI as artifacts for trend tracking.** The `actions/upload-artifact` step in the existing bench workflow is extended to include `packages/bench/results/sync-bundle.json`. No new workflow file; the existing bench job already runs on PR and on main, and adding one more artifact path to the upload step is a one-line change. The artifact is retained for 90 days per the workflow's default retention policy, which is sufficient for one cycle's worth of trend data.
6. **Determinism.** The bench test produces the same numbers on two runs against the same commit. We assert this by running the bench test twice in the same CI job and comparing outputs; any drift is a build-determinism bug, not a bundle-cost issue, and we want it surfaced separately. The most likely source of drift is timestamp-bearing source-map comments, which the bench test strips before measuring. The second most likely source is environment-dependent helpers from esbuild (rare under the pinned esbuild version, but possible across major upgrades).
7. **What the trend curve answers.** Six months from now, when the team is reviewing whether the 12 KB ceiling is still right, the JSON artifact history answers questions like: "did the bundle grow steadily, or was there one large jump?" "did the resource-only and conflict-only primitives grow at similar rates, or did one absorb most of the new cost?" "is the barrel overhead stable, or is it creeping up?" These are the questions §14.2.3 anticipates the team will ask in the next bundle-budget renegotiation; the bench test makes the answers data-backed instead of memory-backed.

## Acceptance gate

The `size` CI gate (existing in the repo, configured against the root `package.json` `size-limit` array, executed via `andresz1/size-limit-action` in `.github/workflows/size.yml`) becomes required-green for the three new rows. A PR that crosses any of the three ceilings — `@causljs/sync (resource-only)` 5 KB, `@causljs/sync (conflict-only)` 7 KB, `@causljs/sync (full import)` 12 KB — fails CI. The §17 commitments table for SPEC.async grows by one row, anchored on this gate, naming the three ceilings and the CI job that enforces them.

The DCE-check assertion in TASK 11.2 concern #3 is also a required-green CI step. A PR that introduces cross-contamination between the resource and conflict modules — for example, a refactor that moves a utility from `resource.ts` into `conflict.ts` and forgets to update the imports — fails the DCE check before it reaches the `size-limit` gate, with a clearer error message ("symbol `X` from conflict.ts found in resource-only bundle, expected zero hits") than a raw byte-count regression. The two gates are layered intentionally: the DCE check fails fast on structural problems, and the `size-limit` gate fails on byte regressions that the DCE check did not classify as structural.

The bench test in TASK 11.4 is **not** a required-green gate; it is informational. The team reads the JSON artifact at planning time, not at PR review time. If the bench test fails (which it should not under any well-formed change to the codebase), CI surfaces the failure as a yellow check, not a red one.

The TDD suite for TASKs 11.1 and 11.2 lands as required-green Vitest tests in `packages/sync/test/exports/` and `packages/sync/test/size-limit/` — six tests in TASK 11.1, six tests in TASK 11.2, twelve total. All twelve must pass on green CI before the EPIC merges.

## Out of scope

- The §13.4 multi-key-resource-family addition (deferred). If it lands on the resource path, the 5 KB resource-only ceiling is renegotiated in that EPIC, not this one. This EPIC flags the renegotiation as a known follow-up in the brutal-critical-review section above. The §13.4 EPIC owner reads this paragraph at scoping time.
- Schema 3 IR (EPIC-1). Independent surface; no dependency in either direction.
- Property suite (EPIC-9). Independent surface; no dependency in either direction.
- A `causl-bundle.toml` config file or any other knob for adopters to tune the bundle on their end. The bundle is what we ship; adopters tune their own bundlers if they want a different shape. We refused to add a config file for one set of ceilings; the `size-limit` array is the config surface, and the adopter's bundler config is the adopter's surface.
- Per-export sub-paths finer than `./resource` and `./conflict`. §14.2 option (b) names exactly these two primitives. If the team later identifies a third primitive worth its own sub-path — say, a future `@causljs/sync/staleness` for staleness-guard logic that grows large enough to warrant its own ceiling — that is a new EPIC, not a scope creep on this one.
- Renegotiation of the 12 KB full-import ceiling. The ceiling is the §14.2 commitment; this EPIC enforces it, it does not change it. A future EPIC that wants to grow or shrink the ceiling owns the §14.2.1-style written-team-consensus paragraph and the spec edit.
- CommonJS support for the new sub-paths. `@causljs/sync` is ESM-only today; this EPIC does not change that. If an adopter asks for CJS, that is a separate EPIC with a separate cost story (CJS interop adds bytes, and the existing ceilings would need to be reconsidered).
- README recommendation about which import shape adopters should prefer. Both shapes are documented and supported; we let adopters choose. A future EPIC may revisit the recommendation if the data shows adopters systematically pick the more expensive shape and complain about it.
- A separate `@causljs/sync-conflict` package to replace the `./conflict` sub-path. This was discussed in the §14.2 working session and rejected: a separate package doubles the publish ceremony, doubles the version-skew failure modes, and adds nothing the sub-path does not already provide. Sub-paths are the right granularity.
- Bundle visualization or treemap tooling (e.g., `source-map-explorer`, `webpack-bundle-analyzer`). The bench-test JSON artifact in TASK 11.4 is sufficient for the trend questions §14.2.3 anticipates; a full visualization is a developer-experience addition, not a budget-enforcement one. If an adopter or a contributor asks for treemap output, that is a separate EPIC.
- Multi-format bundle output (ES2015, ES2020, ESNext targets each separately measured). The bundle is single-target ESM at the workspace's pinned tsconfig target. If an adopter needs an older target they downlevel themselves; we do not double the ceiling rows for hypothetical legacy support.
- Per-PR bundle-impact comments beyond what `andresz1/size-limit-action` posts by default. The action's default comment names the row, the previous size, the new size, and the delta — that is sufficient. We are not adding a custom annotation layer.

## Cross-cutting question: what about `@causljs/sync` adopters who want neither primitive?

A reviewer reading this EPIC might ask: is there an `@causljs/sync` adopter who does not need `resource` or `conflict`? If so, they pay 12 KB for nothing. The answer is no — `@causljs/sync` is the primitive boundary at which an adopter opts in to async behavior at all. The minimum useful import is one of the two primitives; an adopter who wants neither does not install `@causljs/sync` in the first place. The 12 KB ceiling is a ceiling on adopters who use the package, not a tax on adopters who happen to have it transitively in their dependency graph.

The transitive-dependency case is also worth naming: an adopter installs `@causljs/react` (which depends on `@causljs/core` but NOT on `@causljs/sync`), and pays zero `@causljs/sync` bytes. An adopter installs `@causljs/sync` directly because they need async resources, and pays the resource-only ceiling. The dependency graph is constructed so that the per-adopter cost is the union of what they explicitly opt in to, with no transitive surprises.

This is one place §14.2's discipline is doing real work. Earlier in the project, there was a discussion about whether `@causljs/core` should re-export `resource` for convenience — adopters could write `import { resource } from '@causljs/core'` instead of installing `@causljs/sync`. The team rejected the proposal on §14.2 grounds: re-exporting `resource` from `@causljs/core` would either inflate `@causljs/core`'s bundle (if the implementation lived in `@causljs/core`) or add a peer-dependency footgun (if `@causljs/core` re-exported from `@causljs/sync` and the adopter did not install `@causljs/sync`). Keeping the primitive in `@causljs/sync` and forcing an explicit install is the cleaner story; this EPIC reinforces that story by making the cost of installing `@causljs/sync` precisely measurable.

## Cross-cutting question: how does this interact with `@causljs/sync`'s test suite?

The existing `@causljs/sync` test suite under `packages/sync/test/` exercises the primitives via the barrel import: `import { resource, createConflictRegistry } from '@causljs/sync'`. Those tests continue to pass unchanged — the barrel still exists, still exports both primitives, and the test suite has no reason to know whether the primitives are also available as sub-paths.

The new tests in TASK 11.1 land under `packages/sync/test/exports/` and exercise the sub-paths directly. They are additive; no existing test moves, no existing test is rewritten. The two suites coexist and answer different questions: the existing suite asks "do the primitives behave correctly," and the new suite asks "are the import shapes wired correctly."

A separate CI job already runs the existing `@causljs/sync` test suite (`pnpm test --filter @causljs/sync`); the new tests piggyback on the same job via the same Vitest invocation. No new CI job, no new workflow file, no new configuration.

## Implementation timeline

The four tasks are independent in scope but form a natural ordering when implemented:

1. **TASK 11.1 first.** The two new entry files and the `exports` field extension must land before the `size-limit` rows can measure anything; you cannot measure a `dist/resource-entry.js` that does not exist. Estimated effort: half a day, including the six TDD tests.
2. **TASK 11.2 second.** With the entry files building, the three `size-limit` rows are added to root `package.json`, the DCE-check script is wired into the test job, and the six TDD tests are written. Estimated effort: half a day.
3. **TASK 11.2.5 in parallel with 11.2.** The test scaffolding sketches above land as actual test files alongside TASK 11.2. No separate effort — the sketches are the implementer's notes, not a separate task.
4. **TASK 11.4 third.** The bench test depends on TASK 11.1's `dist/` outputs and is independent of TASK 11.2's gate. Estimated effort: half a day, mostly spent confirming determinism and wiring the artifact upload.
5. **TASK 11.3 last.** The README and `docs/bundle-budget.md` update is documentation; it lands once the gate is green and the ceilings are committed. Estimated effort: an hour.

Total: two engineer-days for the EPIC, end to end. The Risk: LOW classification at the top of this document is calibrated to that estimate — additive `package.json` config plus three new files plus one bench test is not a multi-week undertaking.

## Reviewer's checklist

When this EPIC's PRs come up for review, the reviewer should confirm:

- [ ] `packages/sync/package.json` `exports` field has three keys: `.`, `./resource`, `./conflict`. Each key has both `types` and `import` conditions.
- [ ] `packages/sync/src/resource-entry.ts` and `packages/sync/src/conflict-entry.ts` exist and contain only `export` statements.
- [ ] `packages/sync/src/index.ts` is a re-export shell with no top-level runtime code (matches TASK 11.1 test #4).
- [ ] Root `package.json` `size-limit` array contains three new rows with the correct ceilings, paths, names, and `ignore` lists.
- [ ] Root `package.json` `//size-limit` comment is updated to mention the new rows.
- [ ] `.github/workflows/size.yml` runs against the full `size-limit` array (verified by reading the workflow file).
- [ ] DCE-check script is wired as a CI step alongside `pnpm size`.
- [ ] Six TDD tests for TASK 11.1 land in `packages/sync/test/exports/`.
- [ ] Seven TDD tests for TASK 11.2 (including the DCE check) land in `packages/sync/test/size-limit/`.
- [ ] Bench test in `packages/bench/test/sync-bundle.test.ts` produces `packages/bench/results/sync-bundle.json`.
- [ ] `actions/upload-artifact` step in the bench workflow includes the new JSON artifact.
- [ ] README in `packages/sync/` has a "Bundle cost" section with the three ceilings.
- [ ] `docs/bundle-budget.md` has a `@causljs/sync` section.
- [ ] §17 commitments table in SPEC.async grows by one row anchored on the new gate.

If all checkboxes pass, the EPIC has discharged its commitments and the §14.2 bundle budget is no longer a documentation aspiration — it is a CI gate that fails non-zero on regression.

## What this EPIC does not promise

To set expectations honestly: this EPIC ships the gate, it does not ship the optimization. The current `@causljs/sync` bundle measures within all three ceilings on the unmodified codebase; we are not refactoring `resource.ts` or `conflict.ts` to drop bytes. If the team later decides the working targets are too tight (resource-only at 4 KB, conflict-only at 6 KB, full import at 11 KB), that is an optimization EPIC, not a gate EPIC. The gate is the floor below the team's optimization work, not a substitute for it.

Similarly, this EPIC does not promise that the per-primitive cost story is the right cost story for every future adopter. It promises that **today's cost story is enforced**. If the team learns next quarter that the dominant adopter pattern is `import { resource, createConflictRegistry } from '@causljs/sync'` (the barrel) and the sub-imports are unused, that is data for a future EPIC about what to do — possibly nothing, possibly fold the sub-imports back into the barrel, possibly something else. The gate's job is to make the cost legible regardless of which decision the team eventually reaches.

The EPIC closes a gap the survey identified. It does not promise that no other gaps exist, and it does not promise that this is the last bundle-budget EPIC. §14.2 is a living section of SPEC.async, and the team's work against it is ongoing.
