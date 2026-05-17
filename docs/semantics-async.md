# Causl Async Adapter — Denotational Semantics

> The page that lands first for the async adapter, in code as well as prose. Mirrors `docs/semantics.md` for the engine; lifts SPEC.async §3 into a standalone reference. Created in #583 to close the documentation gap SPEC.async §3 / §17 referenced.

## 0. Why this page exists

The engine's denotational semantics live in `docs/semantics.md`. The async adapter (`@causljs/sync`) layers on top of it: a resource is a `Node<ResourceState<T>>` like any other, fed by an external Event source (the loader's Promise). Defining what a *value* means at any commit moment is the foundation that lets two adapter implementations agree on observable behavior.

This page is short by design. The full small-step semantics, theorem statements, and counterexample-fragment patterns are in `SPEC.async.md` §3. This page is the cross-reference adopters reach for first.

## 1. The five-arm domain

```text
ResourceState a :=
  | Idle
  | Loading   { origin : GraphTime; promise : Promise (any) }
  | Loaded    { value : a; origin : GraphTime; loadedAt : GraphTime }
  | Stale     { value : a; origin : GraphTime; loadedAt : GraphTime }
  | Errored   { error : any; origin : GraphTime; erroredAt : GraphTime }

resource(graph, key, opts) : Behavior (ResourceState a)
  where resource(t < registrationTime) = Evicted (Theorem 4)
        resource(t = registrationTime) = Idle
```

The five-arm union is the §6 ResourceFleet sub-statechart. Every transition between arms is one `graph.commit(intent, run)` advancing `GraphTime` by exactly one tick (Theorem 2); the post-commit value is the value `run` staged through `tx.set(node, next)` during Phase A.

## 2. The four named theorems

The full statements (with falsification patterns and mechanical anchors) live in `SPEC.async.md` §3.1. One-line summaries:

| # | Name | One-line |
|---|---|---|
| 1 | Origin pinning | A loader's resolved value lands on exactly the resource node it was issued against. Witness: `theorem-1-origin-pinning.test.ts`. |
| 2 | Single-pipeline mutation | Every observable transition routes through `graph.commit`. Witness: `theorem-2-single-pipeline-mutation.test.ts`. |
| 3 | Promise-identity stability | A `Loading` arm's `promise` field is reference-stable across reads of the same loading episode. Witness: `theorem-3-promise-identity-stability.test.ts`. |
| 4 | Behavior domain | A resource's domain is `[registrationTime, ∞)`; `readAt(node, t < registrationTime)` returns `evicted`. Witness: `theorem-4-behavior-domain.test.ts` (#575). The supporting GraphTime-monotonicity lemma is in `theorem-4-graphtime-monotonicity.test.ts`. |

## 3. Composition with engine primitives

The adapter introduces no new primitive. A resource node IS an `InputNode<ResourceState<T>>`; a conflict registry's public node IS a `DerivedNode<readonly Conflict<T>[]>`. SPEC.md §11 inspection primitives compose unchanged:

- `subscribe(resourceNode, observer)` fires once per `ResourceState` transition.
- `readAt(resourceNode, t)` returns the resource's state at past `t` per Theorem 4.
- `dependencies(resourceNode)` returns `[]` (a resource is an Input, not a Derived).
- `whyUpdated(commit, prev, next)` returns one of the seven `ResourceUpdateReason` values (#577 / SPEC.async §11.1).

## 4. What this page does NOT cover

- The full transition tables (ResourceFleet in `SPEC.async.md` §6.1, ConflictRegistry in `SPEC.async.md` §6.2).
- The forbidden-transition catalogue (`SPEC.async.md` §9.4).
- The race-class S-rows S-1 / S-2 / S-3 (`SPEC.async.md` §9.1.1, with the `docs/race-class-audit.md` cross-reference noting the witness/spec divergence — see §4.1 below for the current witness status).
- The chart-conformance commitment (`SPEC.async.md` §17 commitment 7).

If a question is not answered here, follow the cross-reference into the relevant SPEC.async section.

## 4.1 Current state (as of v0.9.0)

- **Race-detection CI shipped** (EPIC-6 closed). The three-tier pipeline lives in `.github/workflows/race-detection.yml`; Tier-1 runs the property suite at the 1000-trial floor on every PR, Tier-2 runs labelled / path-filtered, Tier-3 runs nightly with the bounded enumerator and the Apalache differential corpus. See `docs/race-detection-tiers.md` for budgets and `docs/apalache-diff-report.md` for the differential classifier (per SPEC §16.7).
- **Race-row witnesses, current naming.** The audit-doc S-row identities are the de facto regression-witness set; SPEC.async §9.1.1 names a different (partially-overlapping) set. As of #919 / #844, the witnesses on disk are:
  - audit-doc S-1 (Stale-async resolution): `packages/sync/test/properties/race-row-S-1.property.test.ts`.
  - audit-doc S-2 (Disposed-mid-load): `packages/sync/test/properties/disposed-mid-load.property.test.ts` (renamed from `race-row-S-2.property.test.ts` in #919 to remove the false SPEC.async §9.1.1 S-2 docstring claim).
  - audit-doc S-3 (Single-writer resolution): `packages/sync/test/properties/single-writer-resolution.property.test.ts`.
  - SPEC.async §9.1.1 S-2 (Open-set drift): `packages/sync/test/properties/conflict-registry-drift.property.test.ts` (#919).
  - SPEC.async §9.1.1 S-1 and S-3 canonical witnesses remain tracked under #566. `docs/race-class-audit.md` is the authoritative cross-reference.

## 5. Provenance

Created 2026-05-03 in #583 to close the documentation reference SPEC.async §3 / §17 / `commitments-audit` named but never authored. Authoritative content lives in `SPEC.async.md`; this page is a one-screen orientation for adopters and reviewers.
