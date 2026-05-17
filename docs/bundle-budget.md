# Bundle budget

Canonical reference for every CI-gated bundle ceiling shipped by
the `causljs/causl-ts` packages. Resolves the deferred
EPIC-11 TASK 11.3 doc page (see issue #11) and is the page the
SPEC §17 commitments table cross-references.

The ceilings are enforced by [`size-limit`][size-limit] cells
declared in the root `package.json`. A PR that crosses any ceiling
fails the `size — bundle-size gate` workflow and must include the
written team consensus per **SPEC §14.2.1** (or `SPEC.async §14.2`
for the async family) or the size-limit bump is rejected.

[size-limit]: https://github.com/ai/size-limit

## How to read this page

Each row is one CI-gated import. The **Limit** is the cap the
`size — bundle-size gate` enforces; the **Path** is the artefact
size-limit reads from. The **Adopter import** column is the line an
adopter writes to opt into the surface; the **Why this ceiling**
column explains the trade-off the team accepted when the cap was
set (or last revised).

## `@causl/core`

Engine core — transactional state for tangled dependency graphs.
Default-import target band per SPEC §14.2 is 15–30 KB; 18 KB is the
working target on the full import.

| Import | Limit | Path | Adopter import |
|---|---:|---|---|
| `@causl/core` (full barrel) | **20 KB** | `packages/core/dist/index.js` | `import { createCausl } from '@causl/core'` |
| `@causl/core` (createCausl-only) | **15 KB** | `packages/core/dist/index.js` (tree-shaken) | `import { createCausl } from '@causl/core'` (no extras) |

> The 4.5 KB / 6 KB / 3 KB ceilings the previous spec defended were
> retired in PR #458 once the team accepted that the small-bundle
> promise was costing more in adopter glue (per closed PRs #266,
> #395, #420, #383, #455, #390, #454) than it was earning in
> elegance. The current 15–20 KB band is the negotiated outcome.

## `@causl/core/wasm` (Phase-1 loader)

Thin loader + `WasmBackend` wrapper. Does NOT include the WASM
artefact itself — the loader fetches it at runtime from the
adjacent `wasm-pkg/*-bundler/` directory.

| Import | Limit | Path |
|---|---:|---|
| `@causl/core/wasm` | **12 KB** | `packages/core/dist/wasm.js` |

### WASM artefacts (raw `.wasm`, pre-Brotli)

The per-bridge `.wasm` cells gate the `-bundler/` variant only;
wasm-pack emits byte-identical bytes for `-bundler` and `-nodejs`
so a separate row pair would duplicate the cap with no extra
signal (PR #1103).

| Bridge | Raw limit | Path |
|---|---:|---|
| `serde-json` | **230 KB** | `packages/core/wasm-pkg/serde-bundler/engine_rs_bg.wasm` |
| `gc-builtins` | **260 KB** | `packages/core/wasm-pkg/gc-builtins-bundler/engine_rs_bg.wasm` |
| `gc-classic` | **260 KB** | `packages/core/wasm-pkg/gc-classic-bundler/engine_rs_bg.wasm` |

The Brotli q11 ceiling is enforced post-compress at
`pnpm wasm:build` upload time and is documented in
`packages/core/wasm-pkg/README.md`.

> **#1150 divergence note.** The `serde-json` raw cell at 230 KB
> exceeds the SPEC §17.6 commitment-14 ceiling of 200 KB raw by
> 13 KB to absorb the current 213 KB serde artefact. The gap is
> documented as Option C divergence in §17.6's current-state
> paragraph; the cell tightens back to ≤200 KB when the Rust
> engine port (epic causljs/causl-wasm#1) lands and wasm-opt is
> invoked directly per PR #1112's design discussion.

## `@causl/react`

React bindings.

| Import | Limit | Path |
|---|---:|---|
| `@causl/react` | **8 KB** | `packages/react/dist/index.js` |

## `@causl/devtools-bridge`

DevTools bridge — the absent-extension path that ships in production
builds when no Redux DevTools is installed.

| Import | Limit | Path |
|---|---:|---|
| `@causl/devtools-bridge` (connectDevtools-only, absent-extension path) | **5 KB** | `packages/devtools-bridge/dist/index.js` |

## `@causl/sync`

Async resource + conflict bindings. Per-primitive sub-imports so
adopters who only need one surface pay only for it.

| Import | Limit | Path | Adopter import |
|---|---:|---|---|
| `@causl/sync` (full barrel) | **12 KB** | `packages/sync/dist/index.js` | `import { resource, createConflictRegistry } from '@causl/sync'` |
| `@causl/sync/resource` (resource-only) | **8 KB** | `packages/sync/dist/resource-entry.js` | `import { resource } from '@causl/sync/resource'` |
| `@causl/sync/conflict` (conflict-only) | **8 KB** | `packages/sync/dist/conflict-entry.js` | `import { createConflictRegistry } from '@causl/sync/conflict'` |

The full barrel re-exports both surfaces. The split is per
**SPEC.async §14.2** — a smaller bundle buys a smaller install
footprint; the ceiling rules out unilateral growth.

> See **SPEC.async §13.4** for the multi-key-resource-family
> renegotiation note: a future composite-resource surface may push
> `@causl/sync/resource` past its current ceiling. That bump
> requires the §14.2 written team consensus.

## Competitor fixtures (bench-only)

These ceilings live in the `packages/bench/fixtures/` tree and
guard against the comparison-bench harness silently regressing
the competitor cells (e.g. importing a transitive dep that
shouldn't be in the bench-fixture tree). They are NOT product
ceilings — adopters never see these imports.

| Fixture | Limit | Path |
|---|---:|---|
| `jotai` (full import) | **20 KB** | `packages/bench/fixtures/jotai-full.ts` |
| `jotai` (atom-only) | **20 KB** | `packages/bench/fixtures/jotai-min.ts` |
| `@reduxjs/toolkit` (full import) | **60 KB** | `packages/bench/fixtures/redux-toolkit-full.ts` |
| `@reduxjs/toolkit` (configureStore-only) | **60 KB** | `packages/bench/fixtures/redux-toolkit-min.ts` |
| `mobx` (full import) | **30 KB** | `packages/bench/fixtures/mobx-full.ts` |
| `mobx` (observable+computed) | **30 KB** | `packages/bench/fixtures/mobx-min.ts` |

## Changing a ceiling

1. Run `pnpm size` locally and confirm the current bytes against
   the proposed new ceiling.
2. Open the PR; the `size — bundle-size gate` workflow runs and
   either passes (the change fits under the existing ceiling) or
   fails (the change crosses a ceiling).
3. If it fails, the PR description **must** include either:
   - the written team consensus per SPEC §14.2.1 (or SPEC.async
     §14.2 for sync), naming the trade-off being made, OR
   - the size-limit bump alongside a closing-the-gap plan with a
     dated target ratchet date.
4. The reviewer either approves the bump-with-consensus, or
     rejects the bump and asks for the diff to be reworked to fit.

The §14.2 narrative pins the trade-off: a smaller bundle buys a
smaller install footprint; the ceiling rules out unilateral growth.

## Cross-references

- **SPEC §14.2** — bundle-budget written-consensus rule (root SPEC,
  applies to the core / wasm / react / devtools-bridge cells)
- **SPEC.async §14.2** — same rule, scoped to `@causl/sync`
- **SPEC §17** — commitments table; rows naming a ceiling
  cross-reference this page
- **SPEC §17.6 commitment 14** — WASM artefact ceiling (200 KB raw
  / 80 KB Brotli per bridge); see the #1150 divergence note above
- `packages/sync/README.md#bundle-budget-specasync-142` — the
  adopter-facing summary for `@causl/sync` specifically
- `packages/core/wasm-pkg/README.md` — Brotli ceilings + the
  per-bridge artefact split rationale (PR #1103)

## History

| Date | Change | Reference |
|---|---|---|
| 2026-05-17 | Page created, consolidating ceilings scattered across `package.json` `//size-limit` keys, `packages/sync/README.md`, and `SPEC §17.6` | issue #11 |
| pre-split | 4.5 KB / 6 KB / 3 KB ceilings retired | PR #458 |
| pre-split | Per-bridge WASM artefact cells activated | Sub-E (#1063 closeout) |
| pre-split | Bundler/Node WASM artefact split | PR #1103 |
| pre-split | `serde-json` cell raised 200 → 230 KB pending Rust port | #1150 |
