# `@causljs/core/wasm`

> ⚠️ **Phase-1 state (0.9.0)** — the `WasmBackend` returned by
> `loadWasmBackend()` is currently a TS engine wrapped in the FFI
> shape, NOT a Rust engine. The interface is stable and the
> cross-bridge byte-identity gate is enforced (#1071); the
> performance characteristics today are equivalent to the TS engine.
> WASM substrate epic #680 closed with all 17 Phase-0 + Phase-1
> sub-issues merged (loader, bridge picker, BackendEngine carve,
> migration envelope, cross-backend determinism gate, host-tier
> matrix, bundle hygiene, Phase-1 perf measurement). Type-shape
> follow-ups #1077 / #1078 / #1079 / #1080 also merged: `engine-rs-core`
> now exposes a `NodeId` generational handle (`{ slot: u32, gen: u32 }`
> post-#1151), a 7-named-struct cell shape, and a
> `JsonValue::Object(BTreeMap<SmolStr, JsonValue>)` value tree
> (post-#1078; an IndexMap swap is under investigation in #1152).
>
> The **real Rust engine port** is the post-0.9.0 epic
> [#1133](https://github.com/iasbuilt/causl/issues/1133) — _deferred_
> behind the GO/NO-GO criteria documented in the epic body. 15
> implementation sub-issues (#1134–#1148), 7 panel-review sub-issues
> (#1154–#1160), and 4 current-code defect issues (#1150–#1153) are
> filed; the bundle-ceiling amendment, NodeId generational disposal,
> JsonValue object-representation bench, and property-test tier
> sweep have already merged via PRs #1161–#1164.
>
> Adopters who pin `backend: 'wasm'` today should expect
> ~0% runtime delta vs `backend: 'js'`. The `backend: 'auto'`
> path stays on TS until commitTimings cross threshold, at which
> point the same TS engine semantics run inside the FFI wrapper.
>
> If you need the structural Rust perf win, watch epic #1133 — the
> Phase-1 Eich/Horwat projection is ~0.7 ms/commit addressable
> against today's wrapper's 2.23 ms / 10k-commit boundary cost
> (PRs #1087 / #1062). Until #1133's GO criteria fire, the wrapper
> is the shipping `WasmBackend`.

Opt-in WebAssembly backend entry point for `@causljs/core`.

## When to use

> **Phase-1 reminder.** Today's `WasmBackend` is a TS-engine wrapper
> (see the callout at the top of this file). The criteria below
> describe the _target_ envelope for the real Rust engine (epic
> #1133). At 0.9.0 the right reason to import this entry point is to
> wire the FFI seam, exercise the host-tier matrix, and surface the
> `WasmBackendUnavailableError` fallback path — **not** to win on
> wall-time, which the wrapper does not deliver.

Importing this entry point will be the right call (post-#1133) when
one (or more) of:

- Graph holds **> 5,000 nodes** and commits run hot enough that the JS
  engine's GC + hidden-class pressure shows up in CPU profiles.
- A single derived chain exceeds **~500 nodes** of depth.
- Aggregate live subscriber count is **> 1,000** and commits churn
  > 10,000 times.
- A workload-specific bench (see `packages/bench/`) reports the WASM
  backend at **≥ 5×** the wall-time win SPEC §16.4 promises for the
  scenario.

For every other case, the default TS engine wins on cold-start latency
and bundle size; importing this module is a net loss. The auto-adapt
heuristic (#686) wires this trade-off into `createCausl({ backend:
'auto' })` so adopters do not have to make the call manually.

## Cost shape

| Surface                                     | Cost                                                                                                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@causljs/core` main bundle                   | Tiny loader stub (~1 KB). No WASM import.                                                                                                                               |
| `@causljs/core/wasm` (this)                   | Loader interface + bridge picker (~2 KB).                                                                                                                               |
| WASM artifact (fetched lazy)                | 60–213 KB raw / 45–66 KB Brotli (GC-builtins ≈ 45 KB Brotli; serde-json **66 KB Brotli, 13 KB over the §17.6 80 KB target** — see Issue #1150 / PR #1161).              |
| First-use migration round-trip              | ~50–200 ms on a 10k-node graph.                                                                                                                                         |
| Per-commit boundary cost (Phase-1, wrapper) | **2.23 ms / 10k commits** (PRs #1087 / #1062). Same TS pipeline runs under the FFI shape — relative-to-serde framing applies only to the future real-Rust port (#1133). |

A graph that never trips the auto-adapt threshold pays only the loader
stub cost; the WASM module is never fetched.

## H1 callout — `graph.read(node)` reference identity is **not** contractual (#1124, ratified by SPEC §15.1 amendment via PR #1129)

> **Pre-migration warning.** `graph.read(node)` is not contractually
> required to return the same JavaScript reference across calls. The
> SPEC §15.1 amendment ratifying this (PR #1129) shipped with 0.9.0.
> Today's `WasmBackend` is a TS-engine wrapper, so `read()` returns
> identical references trivially; the day the real Rust serde /
> wasmgc bridges land under epic #1133, `read()` returns a **fresh
> object per call** as the value is deserialised across the FFI
> boundary. Adopters who `React.memo` / `useMemo` on the read
> return reference re-render every commit silently after
> `migrate('wasm')`. **Memoise on `commit.time` or
> `EngineTelemetry.nodeVersion(node)`, not on the read return
> reference.** See `docs/wasm-adoption-guide.md` § H1 for the
> right-vs-wrong code example, and SPEC §15.1 for the contract
> sentence. The host-tier table below is the migration surface
> where this hazard materialises; read the H1 section _before_
> picking a tier for a production adopter.

## Host requirements

| Host                   | Status                                                              |
| ---------------------- | ------------------------------------------------------------------- |
| **Node**               | 22.0+ (WebAssembly 1.0 baseline). 22.6+ for the GC-builtins bridge. |
| **Chrome / Edge**      | 95+ (WebAssembly 1.0 + `wasm-unsafe-eval`). 131+ for GC-builtins.   |
| **Firefox**            | 102+ (`wasm-unsafe-eval`). 130+ for GC-builtins.                    |
| **Safari**             | 16+ (WebAssembly 1.0). 18.2+ for the WasmGC-classic bridge.         |
| **Cloudflare Workers** | All current versions (`compatibility_date >= 2023-09-01`).          |
| **Deno**               | 1.30+ (`--allow-net` for fetch).                                    |

The bridge picker (`detectBridge()`) probes the host at module load
and selects the most-capable artifact the host actually supports;
hosts that lack WasmGC fall back to the universal `serde-json`
bridge automatically.

## Content-Security-Policy

Modern WASM execution requires `script-src 'wasm-unsafe-eval'`
(Chrome 95+, Firefox 102+; supersedes the legacy `'unsafe-eval'`
escape hatch).

Restrictive CSPs without that directive cause `loadWasmBackend()` to
throw `WasmBackendUnavailableError` with
`code: 'CAUSL_WASM_CSP_BLOCKED'`; adopters branch on the code to fall
back to the TS engine. Document `'wasm-unsafe-eval'` prominently in
the host app's CSP posture before enabling.

For hosts with strict `connect-src`, expose a CDN fallback via
`WasmBackendOptions.wasmBaseUrl`:

```ts
import { loadWasmBackend } from '@causljs/core/wasm'

const backend = await loadWasmBackend({
  wasmBaseUrl: 'https://cdn.jsdelivr.net/npm/@causljs/core@<version>/wasm/pkg/',
})
```

The loader does **not** auto-fallback to the CDN — adopters must
whitelist the chosen origin in their CSP `connect-src` explicitly.

## Bundler interop

This entry point ships against three target bundlers:

- **webpack 5** — set `experiments.asyncWebAssembly: true` so
  `import()` of the `.wasm` artifact resolves through the asset
  module pipeline.
- **Vite 5** — install `vite-plugin-wasm` until the rolldown-native
  WASM path lands. The loader uses `?url`-style URL resolution
  internally.
- **esbuild 0.20+** — pass `--loader:.wasm=file`. The non-streaming
  fallback path covers esbuild's lack of native streaming-instantiate
  glue.
- **Node 22+ ESM** — works out of the box. The artifact is resolved
  through the package's `exports` map.

A fixture matrix lives in `packages/bench/fixtures/bundler-interop/`
(landed via #689); PRs that touch this entry point or the
`wasm-pack` output are gated on every bundler in the matrix
producing a working build.

## API

```ts
import { loadWasmBackend, detectBridge, WasmBackendUnavailableError } from '@causljs/core/wasm'

// Default — auto-detects the fastest bridge supported by the host.
const backend = await loadWasmBackend()

// Pin a bridge.
const backend = await loadWasmBackend({ bridge: 'serde-json' })

// CSP / CDN scenario.
const backend = await loadWasmBackend({
  wasmBaseUrl: 'https://cdn.example.com/causl/wasm/',
})
```

When `loadWasmBackend()` cannot resolve a usable bridge (CSP block,
missing host support, pinned bridge that the host does not support,
or fetch failure), it throws `WasmBackendUnavailableError`. Adopters
branch on the structured `code` field to fall back to the TS engine:

```ts
try {
  return await loadWasmBackend()
} catch (err) {
  if (err instanceof WasmBackendUnavailableError) return jsBackend
  throw err
}
```

See `docs/wasm-adoption-guide.md` §3 for the five structured `code`
values and the per-code adopter dispatch.

## Status

This module ships the **loader, bridge picker, lazy-instantiate
path, and Phase-1 `WasmBackend`** (TS-engine wrapper). All the
sub-tasks that originally gated this entry point landed under epic
#680 (closed):

- #682 — Rust workspace + `engine-rs-core` + bridge crates. **Merged.**
- #683 — `wasm-pack` build pipeline + dual-artifact GC bridge. **Merged.**
- #693 — `serde_json` + UTF-8 fallback bridge (the universal baseline). **Merged.**
- #691 — Pluggable Bridge interface + feature-detection harness. **Merged.**
- #681 — `BackendEngine` interface in TS. **Merged.**
- #684 — JS bindings + lazy-load loader + `@causljs/core/wasm` entry. **Merged (PR #1031).**
- #685 / #687 / #689 / #690 — determinism gate, migration envelope, bundle hygiene, host-tier matrix. **Merged.**

EPIC: [#680](https://github.com/iasbuilt/causl/issues/680) — **closed**.
Post-0.9.0 real Rust engine port: [#1133](https://github.com/iasbuilt/causl/issues/1133) — **deferred**, GO/NO-GO criteria in epic body.

### Current-state divergences

- **Wrapper, not Rust engine.** The shipping `WasmBackend` invokes
  the TS commit pipeline under the FFI shape. Real Rust commit-path
  execution is epic #1133.
- **Serde bridge bundle ceiling (Issue #1150, amended via PR #1161).**
  The `serde-json` bridge ships at 213 KB raw / 66 KB Brotli, **13 KB
  over** the SPEC §17.6 commitment 14 target of 80 KB Brotli. PR #1161
  amended the size-limit ceiling and documented the divergence as
  acknowledged debt; the GC-builtins and GC-classic bridges remain
  within budget.

## See also

- **SPEC §17.1 commitment 14** + **SPEC §17.6** — the host-tier
  substrate-compatibility commitment (#690 amendment). Commitment
  14 is the SPEC-level contract that this README's host-requirements
  table and the bridge picker's auto-walk behaviour implement.
- **`docs/wasm-adoption-guide.md`** — adopter-facing guide for the
  preload + Subresource Integrity (SRI) posture, dynamic-import
  patterns for vendoring the WASM artefacts, and the structured
  `WasmBackendUnavailableError` fallback dispatch (the five `code`
  values) for hosts where WASM is not available.
