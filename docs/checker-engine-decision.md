# Phase 6.1 — Engine evaluation timebox

**Decision:** ship `causl-check` as a small Rust crate that does
**from-scratch** explicit-state enumeration over the CauslModel IR
defined in Phase 6.2. Borrow ideas from `stateright`, `loom`, and
`kani`; do not pull them in as dependencies in v0.

> **Current state (as of v0.9.0).** This document records the
> original Phase 6.1 decision. What actually shipped:
>
> - `tools/checker/` is the **static IR linter** — 12 passes today
>   (the 8 named in §16's original list plus the 4 §16A.2 lifetime
>   passes: `SubscribeWithoutDispose`, `CommitFromSubscribe`,
>   `CrossGraphRead`, `UseAfterDispose`). It is one-shot, never
>   enumerates state, and is wired into CI as the per-PR gate via
>   `@causljs/checker`.
> - `tools/enumerator/` is the **from-scratch BFS** described here,
>   targeting the same IR. Per SPEC §16.0 / §16.4 the linter is
>   what ships; the enumerator is **deferred PLANNED** per #272
>   closed not-planned. The crate exists today because the
>   four-way classifier (#1070, EPIC-7) and `tools/apalache-diff/`
>   (#574) consume the BFS half as a differential oracle against
>   the TS engine and the two WASM bridges.
> - The Phase 6.2 IR landed; the v0 sub-tasks #52–#59 (last item in
>   this doc) all shipped. The IR is now at schema 3 (SPEC §16.A
>   schema-bump record).
> - No dep from the "tools we said no to" table (stateright, loom,
>   kani, shuttle, miri) was pulled into the Cargo dep graph; the
>   `forbid(unsafe_code)` lint at the top of `tools/checker/src/main.rs`
>   and the bare workspace `Cargo.toml` show this is still honored.

## What I evaluated

| Tool | What it gives us | What it costs |
| --- | --- | --- |
| **stateright** | Mature explicit-state model checker; idiomatic Rust API for `Model` + `Property`. Closest spirit-match. | 18k LOC dep; opinionated `actor` model that doesn't fit Causl's "one commit advances time" semantics; reduces to spamming actor messages — overkill for what we need. |
| **loom** | Memory-model interleavings — built for `unsafe` concurrency. | We don't have unsafe code. The "interleaving" we want is *commit-message orderings*, not Acquire/Release fences. Wrong tool. |
| **kani** | Bounded MIR proof via CBMC. | Catches arithmetic UB / panic safety, not Causl semantic invariants. We'd be retro-fitting `kani_assert`s and praying CBMC scales over a 100-node graph. Too imprecise for our acceptance criteria. |
| **shuttle** | Randomised concurrency — like `loom` but cheap. | Same "we don't have unsafe code" problem; randomisation adds nothing over fast-check at the JS level. |
| **miri** | Detects Rust UB, not Causl invariants. | Out of scope. |
| **From scratch** | Tiny crate. Direct mapping `IR → State → Property`. We control the bounds, the shrinker, and the report format. | We write the BFS/DFS ourselves. ~500 LOC for the v0 enumerator. |

## Why from-scratch wins for v0

1. **The state we explore is already small.** The IR caps at 100 nodes
   / 500 commits / 10 resources / 50 message-depth (SPEC §16.2). A naive
   BFS over this fits in a single Rust file with a `HashMap` for the
   visited set.

2. **The properties are domain-specific.** Glitch-freedom, dynamic-dep
   correctness, statechart conformance — none of these are
   `stateright`'s `Property::sometimes` / `always`. Writing them
   directly as Rust closures is faster than fighting a generic.

3. **Error messages are the product.** Devs don't want a stack of
   `actor sent`/`received` traces from stateright; they want
   "node sum (id=sum) read deps {a, b} but the engine had {a} after
   commit c12 (intent=`bump-a`)." That report format is bespoke,
   so the enumerator owes us very little.

4. **It's the smallest thing that earns the right to grow.** If the
   bounds need to push past what BFS can do, we can swap in stateright
   under the same crate boundary without changing the npm wrapper or
   the CI gate.

## What we explicitly defer

- Symbolic execution. CBMC-style "all values of T at this point" is a
  cliff: implementing it from scratch is a year. If §9.1 coverage
  plateaus and concrete enumeration is the bottleneck, we revisit.
- Distributed/multi-actor simulation. Phase 6 covers single-graph
  programs; multi-user is a future-epic problem (SPEC §13).
- Cache-line / memory-model interleavings. JavaScript runtime is
  single-threaded; the `loom`-shaped concern doesn't apply.

## What lands in the next sub-tasks

All Phase-6 sub-tasks shipped; the list is retained as a historical
record of the Phase-6 plan. Cross-references below point at the
shipped surface.

- `#52` — Define `CauslModel` IR + JSON schema (the data the JS
  side exports; the data the Rust side consumes). **Shipped;**
  IR is at schema 3 today (post-§16A schema bumps).
- `#53` — Implement `graph.exportModel()` in `@causljs/core`.
  **Shipped.**
- `#54` — Set up `tools/checker/` Rust crate skeleton. **Shipped.**
- `#55` — Implement the bounded model checker (the from-scratch
  BFS). **Split.** The static linter shipped under
  `tools/checker/`; the bounded BFS landed under `tools/enumerator/`
  and is deferred PLANNED per #272. Both crates target the same IR.
- `#56` — Ship the `@causljs/checker` npm wrapper. **Shipped**
  (per-platform `optionalDependencies`, devDependency only — see
  SPEC §16.7).
- `#57` — Wire `causl-check` into CI on the Phase 3 + Phase 4
  demos. **Shipped.** The PR gate ran under
  `.github/workflows-disabled/race-detection.yml`'s Tier-1 design;
  per-pass acceptance fixtures under
  `tools/checker/tests/fixtures/` are the SPEC §17 commitment 9
  anchor.
- `#58` — Publish `docs/checker-coverage.md` (annotated §9.1
  catalogue). **Shipped** — see that file for the current
  per-row coverage table.
- `#59` — Hand-crafted regression suite per §9.1 row. **Shipped**
  under `tools/checker/tests/`.

## Acceptance for #51

- This document landed and reviewed.
- One row per evaluated tool with a recorded reason.
- Tools we said no to are not pulled into the Cargo dependency graph
  in #54.
