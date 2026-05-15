# WASM adoption guide (#690, merged)

Adopter-facing companion to SPEC §17.6 (commitment 14, host-tier
substrate compatibility — ratified via PR #1053) and to the
entry-point reference at `packages/core/wasm/README.md`. This
document covers the five adopter-side questions §17.6's host-tier
table does not answer on its own:

> **Current-state note (0.9.0).** The `WasmBackend` returned by
> `loadWasmBackend()` is currently a **TS-engine wrapper** (Phase-1,
> Sub-D #1065 / SPEC §17.6's "wrapper-not-Rust" disclosure landed via
> PR #1127). The interface is stable, the host-tier matrix is live,
> the cross-backend determinism gate (#685) is green at 10 000 trials,
> and the per-bridge size-limit cells gate. **The real Rust engine
> port is the post-0.9.0 epic #1133, deferred behind GO/NO-GO
> criteria.** Until #1133 lands, expect ~0% wall-time delta vs the
> default TS engine. The contracts and patterns in this guide are
> written so they survive the migration the day the Rust port ships.

0. **H1: long-held value references** (#1124). Why
   `React.memo(component, (prev, next) => prev.value === next.value)`
   or `useMemo(() => transform(value), [value])` silently re-renders
   every commit the day you `migrate('wasm')`, and the
   `commit.time`-keyed pattern that survives the migration.
1. **Preload + Subresource Integrity (SRI).** How to make the WASM
   bytes part of your CSP / SRI posture rather than an out-of-band
   fetch.
2. **Dynamic-import patterns for vendoring.** How to ship the WASM
   artefacts from your own origin (CDN, S3, intranet) without
   forking the loader.
3. **Fallback strategy when WASM is unavailable.** The structured
   `WasmBackendUnavailableError` code field and the
   `try`/`catch` shape that lets one codebase target every host in
   §17.6's matrix.
4. **Where to read the host-tier matrix.** A pointer at the
   authoritative spot in `packages/core/wasm/README.md` and the
   SPEC §17.6 elaboration.

This guide is normative for adopters; the SPEC §17.6 row is
normative for the team.

## H1. Long-held value references (the load-bearing pre-Rust-swap risk)

The Markbåge/Miller ship-verdict panel flagged this as the H1 risk
in the WASM-backend adopter audit (`docs/wasm-backend-adopter-audit.md`,
PR #1021), and the SPEC §15.1 amendment ratifying the non-contract
shipped via PR #1129: **`graph.read(node)` is not contractually
required to return the same JavaScript reference across calls.**
Reference identity is an implementation detail of today's TS engine
— the current `WasmBackend` shipped under 0.9.0 is a TS-engine
wrapper (Phase-1; epic #680 closed, real-Rust port deferred to epic
#1133), so a `read()` for an object-valued node returns the same
reference trivially. The day the real Rust `serde-json` / `wasmgc`
bridges land under epic #1133, `read()` will return a **fresh
object per call** as the value is deserialised across the FFI
boundary.

Adopters who memoise on the read return reference re-render every
commit silently once they flip the backend. The hazard is at
migration time (i.e. when the real Rust engine ships), not at first
ship under 0.9.0 — the bug does not show up under the Phase-1
wrapper because the wrapper delegates to the TS engine and TS
returns the same reference. **Write code that survives the
migration today, not the day after.**

### The wrong pattern (silently breaks under `migrate('wasm')`)

```tsx
import { useEffect, useState, useMemo } from 'react'
import { useCausl } from '@causl/react'

function Dashboard({ userNode }) {
  const user = useCausl(userNode) // user: { name, email, ... }

  // WRONG: keys on the reference of `user`. Under the TS engine,
  // `user` is the same object across commits where `userNode`
  // didn't change, so `transformedUser` is memoised correctly.
  // Under WASM, every read returns a fresh object — `user`'s
  // reference changes every commit, `useMemo` invalidates every
  // commit, `transform(...)` runs every commit, every downstream
  // memo invalidates, and the dashboard re-renders every commit.
  const transformedUser = useMemo(() => transform(user), [user])

  return <UserCard data={transformedUser} />
}
```

### The right pattern (survives the migration)

Key the memo on **`commit.time`** (the `GraphTime` exposed on
every `Commit` record — monotonic per SPEC §3 atomicity) or on
the per-node version counter exposed by `EngineTelemetry`. Both
survive the reference-identity break because both are value-typed
across the FFI boundary:

```tsx
import { useMemo } from 'react'
import { useCausl, useCauslCommit } from '@causl/react'

function Dashboard({ userNode }) {
  const user = useCausl(userNode)
  const commit = useCauslCommit() // commit.time: GraphTime

  // RIGHT: keys on `commit.time` (a number that monotonically
  // advances) plus the node id. The memo invalidates iff the
  // commit time changes AND the read returns a different value —
  // both conditions are backend-independent.
  const transformedUser = useMemo(() => transform(user), [commit.time, user])

  return <UserCard data={transformedUser} />
}
```

The `[commit.time, user]` dependency array works under both
backends because:

- **Under the TS engine.** `user` reference is stable across
  commits that don't write to `userNode`; `commit.time` advances
  every commit. `useMemo` re-runs every commit, but
  `transformedUser`'s shape is whatever `transform(user)` returns
  — if `transform` itself returns a stable shape for a stable
  input, downstream `React.memo` boundaries hold.
- **Under WASM.** `user` reference changes every commit (a fresh
  deep-copy); `commit.time` still advances every commit.
  `useMemo` re-runs every commit (same as TS); the downstream
  `React.memo` boundary holds the same way.

The two backends end up observably equivalent at the
`React.memo` boundary, which is the contract surface that
matters — the engine cannot promise reference equality of
`read()` returns, but it does promise commit-time monotonicity
and the value-equality of any two reads at the same `GraphTime`.

### Alternative: `EngineTelemetry`'s per-node version counter

For workloads where `commit.time` is too coarse (e.g. the dashboard
holds many nodes and only a few advance per commit), key on the
per-node version counter `EngineTelemetry` surfaces:

```ts
import { useMemo } from 'react'
import { useCausl, useEngineTelemetry } from '@causl/react'

function ExpensiveTransform({ node }) {
  const value = useCausl(node)
  const telemetry = useEngineTelemetry()
  // Per-node version counter — advances iff this node's value
  // actually changed at the most recent commit.
  const version = telemetry.nodeVersion(node)

  return useMemo(() => expensiveTransform(value), [version])
}
```

This is the right shape for "memo on commit only if this specific
node changed" — the per-node version counter is backend-independent
by construction.

### Cross-link

- **SPEC §15.1 amendment (Issue #1124, ratified via PR #1129).** The
  contract-level statement: reference identity is not part of the
  `graph.read(node)` contract; adopters must memoise on `commit.time`
  or `EngineTelemetry.nodeVersion(node)`.
- **SPEC §17.6.** Names the migration boundary where this hazard
  materialises (TS → WASM via `migrate('wasm')` or
  `createCausl({ backend: 'wasm' })`). Note that under the Phase-1
  wrapper the hazard does _not_ materialise observably; it
  materialises the day the real Rust port lands (epic #1133).
- **`docs/wasm-backend-adopter-audit.md` H1.** PR #1021's audit
  doc; the H1 row is this hazard. PR #1129 executed the SPEC §15.1
  amendment the audit recommended; this section is the
  adopter-facing companion.
- **`packages/core/wasm/README.md` H1 callout.** Adopter-facing
  callout above the host-tier table that points at this section.

## 1. Preload + SRI

The WASM artefact is fetched lazily on the first `loadWasmBackend()`
call. Adopters who want predictable first-paint behaviour preload
the bytes; adopters with a strict CSP also pin the SRI hash.

### Preload (recommended for SPA shells)

Add a `<link rel="modulepreload">` for the JS bindings and a
`<link rel="preload" as="fetch">` for the `.wasm` artefact:

```html
<!-- Tier 1 host (Chromium 131+, Firefox 130+, Node 22.6+) -->
<link rel="modulepreload" href="/causl/wasm-pkg/gc-builtins/engine_rs.js" />
<link
  rel="preload"
  as="fetch"
  type="application/wasm"
  href="/causl/wasm-pkg/gc-builtins/engine_rs_bg.wasm"
  crossorigin="anonymous"
/>
```

For Tier 2 (`gc-classic`) and Tier 3 (`serde`) hosts, swap the path
segment. A production setup typically emits all three preload
pairs and lets the browser fetch the one its bridge picker
ultimately needs — preload requests are cheap to issue and the
unused two simply do not enter execution.

Pair with `<link rel="dns-prefetch">` if your CDN sits on a
separate origin from the document.

### Subresource Integrity (SRI)

If your CSP includes `require-sri-for script` or your security
posture pins every external asset by hash, compute the SRI digest
of each bridge artefact at build time and add it to the preload
link:

```html
<link
  rel="preload"
  as="fetch"
  type="application/wasm"
  href="/causl/wasm-pkg/gc-builtins/engine_rs_bg.wasm"
  integrity="sha384-..."
  crossorigin="anonymous"
/>
```

The SRI hash is computed over the **raw `.wasm` byte sequence**
(not the JS-bindings glue produced by `wasm-pack`). Recompute on
every causl release because the artefact bytes change with the
Rust crate version.

> **CSP reminder.** WASM execution requires
> `script-src 'wasm-unsafe-eval'` (Chrome 95+, Firefox 102+;
> supersedes the legacy `'unsafe-eval'` escape hatch). The preload
> link is fetched against `connect-src` (or `default-src` if you
> have not split them) — whitelist your CDN origin explicitly.
> Hosts whose CSP forbids `'wasm-unsafe-eval'` automatically fall
> through to the JS-engine fallback per §17.6 (the loader throws
> `WasmBackendUnavailableError` with `code: 'CAUSL_WASM_CSP_BLOCKED'`).

## 2. Dynamic-import patterns for vendoring

`@causl/core/wasm` ships with a default loader that resolves the
`.wasm` artefact via the package's `exports` map. Adopters who
host their own copy (CDN, S3, intranet asset server) override the
base URL through `WasmBackendOptions.wasmBaseUrl`:

```ts
import { loadWasmBackend } from '@causl/core/wasm'

const backend = await loadWasmBackend({
  wasmBaseUrl: 'https://cdn.example.com/causl/0.0.0/wasm-pkg/',
})
```

The loader appends the bridge-id segment (`gc-builtins/`,
`gc-classic/`, or `serde/`) and the artefact filename
(`engine_rs_bg.wasm`) to the base URL. The base URL **must end with
a trailing slash**; the loader does not normalise.

### Versioned vendoring

Every causl release pins the WASM artefacts at the package's
version string (`VERSION` exported from `@causl/core`). A
deployment-time script that copies `node_modules/@causl/core/wasm-pkg/`
into your asset server should preserve the version segment so the
SRI hashes in the preload links stay correct:

```sh
# deploy-time
VERSION=$(node -e "console.log(require('@causl/core').VERSION)")
cp -r node_modules/@causl/core/wasm-pkg ./public/causl/$VERSION/wasm-pkg
```

And at runtime:

```ts
import { VERSION } from '@causl/core'
import { loadWasmBackend } from '@causl/core/wasm'

const backend = await loadWasmBackend({
  wasmBaseUrl: `/causl/${VERSION}/wasm-pkg/`,
})
```

### Picking a specific bridge tier

The loader's `detectBridge()` auto-selects the highest tier the
host supports. Adopters who need a specific tier — typically for
testing the fallback path under a Tier 1 dev environment — pin
the bridge explicitly:

```ts
// Force Tier 3 (universal) — useful for cross-browser parity testing
const backend = await loadWasmBackend({ bridge: 'serde-json' })

// Force Tier 1 — hard error on Safari 18.0 (WasmGC but no JS string builtins)
const backend = await loadWasmBackend({ bridge: 'wasmgc-builtins' })
```

Pinning a bridge that the host does not support throws
`WasmBackendUnavailableError` with
`code: 'CAUSL_WASM_BRIDGE_UNAVAILABLE'`. The auto-walk path
(`bridge` omitted or `bridge: 'auto'`) never throws on host
mismatch — it walks down the tier ladder per §17.6 and surfaces
the chosen tier on the returned backend's `BridgeFeatures` shape.

## 3. Fallback strategy when WASM is unavailable

SPEC §17.6 names the TS engine as the unconditional floor: any
host that runs JavaScript runs causl. The WASM substrate is
_acceleration_, not _substitution_. The structured fallback
contract is:

```ts
import { createCausl } from '@causl/core'
import { loadWasmBackend, WasmBackendUnavailableError } from '@causl/core/wasm'

async function makeBackend() {
  try {
    return await loadWasmBackend()
  } catch (err) {
    if (err instanceof WasmBackendUnavailableError) {
      // Log the structured `code` field so observability surfaces
      // tell you which fallback fired.
      console.info('[causl] WASM unavailable, using TS engine', err.code)
      return 'js' as const
    }
    throw err
  }
}

const graph = createCausl({ backend: await makeBackend() })
```

### The five structured codes

The `WasmBackendUnavailableError.code` field is the public contract
for fallback dispatch. The five codes are:

| Code                            | Condition                                                                                       | Adopter action                                                                                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAUSL_WASM_NOT_BUILT`          | The bridge artefacts have not yet shipped (pre-#682 / #683 / #693).                             | Fall back to `'js'`. Will resolve once the upstream sub-tasks land.                                                                           |
| `CAUSL_WASM_UNAVAILABLE`        | `WebAssembly` is not defined or `WebAssembly.Module` cannot instantiate the probe module.       | Fall back to `'js'`. The host does not support WebAssembly 1.0.                                                                               |
| `CAUSL_WASM_CSP_BLOCKED`        | The host runtime supports WASM but the page's CSP rejected `'wasm-unsafe-eval'`.                | Fall back to `'js'`, or widen the CSP if the security review allows it.                                                                       |
| `CAUSL_WASM_BRIDGE_UNAVAILABLE` | Adopter pinned a specific bridge id that the host does not support.                             | Either drop the pin (let `detectBridge()` auto-walk) or fall back to `'js'`.                                                                  |
| `CAUSL_WASM_FETCH_FAILED`       | The `.wasm` byte stream failed to fetch — network error, wrong MIME type, 404 on `wasmBaseUrl`. | Verify the `wasmBaseUrl` resolves and the asset server returns `Content-Type: application/wasm`. Fall back to `'js'` for the current session. |

### Behaviour-equivalence across the fallback

SPEC §17.6 commits to behaviour-equivalence: the JS engine and the
WASM substrate are semantically identical per the SPEC §3 contract
surface (atomicity, glitch-freedom, replay determinism) and the
§15.1 cross-backend determinism gate (landed in #685; reinforced by
the Phase-1 fuzz green at 10 000 trials per `docs/wasm/phase-1-perf.md`).
A graph that falls through to the TS engine on a CSP-restricted host
produces the same `commitLog` it would have produced on a Tier 1
host — only slower per the §17.5 capability-cost residual. Under
the Phase-1 wrapper, "only slower" is in fact ~0% delta because the
wrapper delegates to the same TS pipeline; the residual cost
projection (~0.7 ms/commit) applies to the real Rust port (epic
#1133), not to 0.9.0.

Adopters do not need to test their application against both
backends for correctness; the cross-backend property fuzz (#685)
holds that line. They _do_ need to size their bundle budget
against the fallback floor — see the §14.2 ceiling in the SPEC,
and note the documented serde-bridge divergence (Issue #1150 /
PR #1161 — 13 KB Brotli over the §17.6 80 KB target).

### When to short-circuit the probe

Server-side renderers and CLI tools that know their host runtime
in advance can skip the probe entirely:

```ts
// Node 22.6+ — bypass the probe, go straight to Tier 1
const backend = await loadWasmBackend({ bridge: 'wasmgc-builtins' })
```

```ts
// Browser environments where bundle budget matters more than perf
const graph = createCausl({ backend: 'js' })
```

The `backend: 'js'` short-circuit never imports `@causl/core/wasm`
at all — adopters who pin the TS engine pay zero bundle cost for
the WASM entry stub.

## 4. Batched-flush opt-in (`createCausl({ batchedFlush })`)

> **Read this framing first. `batchedFlush` delivers ZERO
> adopter-visible performance change at v1.x.** It is *scaffolding*
> for a possible future v2.x cutover, not a speed knob you turn on
> today. If you are looking for "make causl faster", this option is
> not it — the JS engine remains the single source of truth for
> every read, subscribe, and `commit()` return regardless of this
> setting. Turning it on changes only *when the WASM-side shadow wire
> crossing happens*, which is invisible to your application code.

### What it is

Epic #1493 (the #1483 re-architecture decision's option-c
implementation) added a per-graph opt-in that buffers the WASM-side
shadow commit-wire crossing and flushes it as one batched envelope
instead of one envelope per commit:

```ts
import { loadWasmBackend } from '@causl/core/wasm'

const backend = await loadWasmBackend({
  batchedFlush: { afterN: 100, intervalMs: 16 },
})
```

…or, on the `backend: 'auto'` path:

```ts
import { createCausl } from '@causl/core'

const graph = createCausl({
  backend: 'auto',
  batchedFlush: { afterN: 100 }, // forwarded to loadWasmBackend on migration
})
```

- **`afterN`** (default `1`) — flush after this many buffered commits.
  `1` flushes every commit, which is **byte-identical to omitting the
  option entirely** (and to pre-#1493 dev). Set `100` for the
  "production-grade" batch window or `312` for the
  `docs/epic-1483/option-c-batched-boundary.md` §1 kill-threshold
  window.
- **`intervalMs`** (default `16` — one 60 Hz frame) — flush after this
  many ms even if `afterN` is not reached, so a low commit rate does
  not strand buffered work. `0` disables the time trigger.
- **Manual flush** — `backend.flush()` forces any buffered window
  across the wire NOW (before navigation, before `snapshot()`, in
  tests).
- **Implicit flush** — `snapshot()` and `dispose()` flush
  automatically so the WASM-side state reflects committed work.

### What does NOT change (the contract you can rely on)

`createCausl({ batchedFlush })` preserves every adopter-facing
contract verbatim (SPEC §17.6 "Option (c) batched-commit boundary
scaffolding" callout; option-c doc §2.1 Answer C):

- **`commit()` still returns a frozen `Commit` synchronously.** Phases
  A–H run in the JS engine on the same tick; there is no `Promise`,
  no deferred apply, no codemod.
- **`graph.now` still advances by exactly one tick per commit**, always
  (SPEC §3 Theorem 4).
- **Per-node and `subscribeCommits` subscribers still fire per-commit,
  synchronously**, in the same call stack as `commit()`'s return
  (SPEC §15.3 — subscriber fires are NOT batched; option (c) pins
  this deliberately).
- **`read()` returns the JS engine's authoritative value** — no FFI
  round-trip on the read path.
- **Default behaviour is byte-identical to not passing the option.**
  This is a load-bearing acceptance test (epic #1493 phase C.4):
  default-config `commit`/`read`/`subscribe`/`exportModel`/`now` is
  byte-identical to a bare pure-TS `createCausl()` graph.

The opt-in is **per-graph** (not a global flag) and **additive** (no
deprecation cycle, no lint, no RC track). Multi-graph adopters
(`@causl/sync`, embedded use-cases) opt in per graph without
cross-graph coupling.

### Why turn it on at all, then?

You generally should **not**, at v1.x. The batched-flush capability
exists so a *future* v2.x cutover that moves the single source of
truth into the WASM/Rust engine can do so without re-paying the
per-commit FFI boundary tax — the wire is already batched. The C.6
`op-rust-batch-boundary` measurement confirms the boundary tax
amortises exactly `15.64 / N` μs per the option-c doc §1 arithmetic
(crossing the ≤50 ns floor at N≥312), but under the v1.x "JS engine
SSOT" architecture that amortisation buys *no adopter-visible perf* —
it is the ceiling a future SSOT swap would obtain, not today's cost.
The #1133 boundary-tax falsification is **not** refuted by this
capability; epic #1493 ships the plumbing, not the perf.

If you have a specific reason to exercise the batched wire path early
(e.g. you are validating the v2.x cutover in a staging harness), set
`afterN` to your target window and use `backend.flush()` at
quiescence boundaries. Otherwise, leave it unset.

## 5. Where to read the host-tier matrix

The authoritative host-tier compatibility matrix lives in two
places, both maintained in lockstep:

- **`packages/core/wasm/README.md`** — adopter-facing entry-point
  documentation, with the per-bridge bundle costs, CSP guidance,
  and bundler-interop notes.
- **SPEC §17.6** — the host-tier matrix as a SPEC commitment
  (commitment 14, DESIGN-DISCIPLINE), with the four feature-detection
  probes named, the bundle-size ceiling table, and the
  fall-through fallback contract.

When a new host version graduates a WASM feature (e.g. Safari ships
JS String Builtins, promoting it from Tier 2 to Tier 1), both
documents update in the same PR per SPEC §17.6's DESIGN-DISCIPLINE
mechanism. Adopters checking the floor for a specific host should
read the SPEC §17.6 row first — it is the contract — and the
README for the implementation detail.

## Cross-references

- SPEC §17.1, commitment 14 — the contract row (ratified via PR #1053).
- SPEC §17.6 — the host-tier elaboration, feature-detection
  checklist, bundle-size impact, fall-through fallback.
- SPEC §19 — the amendment trail rows for #690 (host-tier matrix)
  and #1124 (read-reference identity, ratified via PR #1129).
- `packages/core/wasm/README.md` — entry-point reference, bridge
  picker behaviour, bundler interop.
- `docs/wasm-backend-adopter-audit.md` (#695, **merged**) — the
  Phase-0 adopter-API audit that gated the `BackendEngine` carve in
  #681 (**also merged**).
- EPIC #680 — the full WASM-backend design (**closed**; 17 sub-issues
  merged).
- EPIC #1133 — the post-0.9.0 real Rust engine port (**deferred**
  behind GO/NO-GO criteria).
