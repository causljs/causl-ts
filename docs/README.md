# `docs/` — point-in-time design & historical records

> **Read this first.** Most files under `docs/` (the `epic-1133/`, `epic-1483/`, `epic-1515/`,
> `epics/`, `bench/` corpus, `semantics.md`, `lifecycle.md`, `wasm-backend-adopter-audit.md`,
> `phase-1-perf.md`, …) are **point-in-time design and historical records for this TS-only fork's
> frozen state**. They are intentionally preserved as-written and are **not** kept current with the
> wider org. Two things follow:
>
> 1. **Dead issue links.** Issue/epic references of the form `#NNNN` (and any
>    `github.com/iasbuilt/causl/...` URLs) point at the org's pre-split tracker, which **no longer
>    resolves** — `causljs` is now a multi-repo split, not the old `iasbuilt/causl` monorepo. The
>    links are left intact for historical traceability; do not expect them to open.
>
> 2. **Superseded verdicts.** Several documents describe the Rust→WASM cutover as *deferred* /
>    *tripwire-gated* (e.g. `epic-1515` "85× NOT cleared", "#1133 falsification STANDS",
>    `DEFAULT_WASM_ENGINE_MODE = 'js-ssot'`). Those verdicts are **accurate for THIS repo**, which is
>    genuinely frozen at its pre-fork-split Phase-1 state (the WASM backend here is a TS-engine
>    wrapper). Org-wide they have been **superseded**: the real Rust engine shipped and `rust-ssot`
>    is the **unconditional production default** in
>    [`causljs/causl-wasm`](https://github.com/causljs/causl-wasm) (the per-flush byte-compare oracle
>    and sticky-downgrade fail-safe were removed; perf was ruled UX-immaterial / §14 RAIL), reached
>    through the thin TS API in [`causljs/causl-client`](https://github.com/causljs/causl-client).
>
> **For the current production / enterprise story, see `causljs/causl-wasm` and `causljs/causl-client`
> — not these records.** The one adopter-facing doc here that is in scope and carries its own
> superseded-by header is [`wasm-adoption-guide.md`](./wasm-adoption-guide.md).
