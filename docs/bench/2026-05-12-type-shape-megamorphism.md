# Type-shape megamorphism audit — `Node<T>`, `Entry`, hot-path V8 ICs

Date: 2026-05-12
Scope: `packages/core/src/graph.ts` + `packages/core/src/types.ts`
Lens: Hejlsberg — types create polymorphism; polymorphism erodes V8 inline-cache (IC) stability.

## TL;DR

The engine is already heavily monomorphised at the **storage-shape** level:
`InputEntry` and `DerivedEntry` are pinned hidden classes (#703 Win 5, #760,
#915, #994, #995), and the public `Node<T>` handle is a 1-field frozen
`{ id }` object — its `T` is a phantom-only brand (`_phantom?`) that never
exists at runtime. The single `Map<NodeId, Entry>` storing both variants
is the right call: `entries.get(id)` is a monomorphic Builtins_MapGet site
that V8 inlines (graph.ts:1629). **The polymorphism is NOT in the engine's
type plumbing — it is in the user-supplied `compute` closure return types
and the `e.value as T` cast on every `readEntryFromResolved`.**

Three sites are worth a closer look. None of them rise to a "split the
Map" rewrite; the highest-leverage win is type-specialised `read` paths
that compile into per-shape monomorphic IC chains at user call-sites.

## Hot-path types that vary per-node value type

### Site 1 — `readEntryFromResolved` (graph.ts:1640)

```ts
function readEntryFromResolved<T>(e: Entry, node: Node<T>): T {
  if (e.kind === 'input') { ... return e.value as T }
  ...
  return e.value as T
}
```

`e.value` is typed `unknown` on `InputEntry`/`DerivedEntry` (graph.ts:147,
256). At runtime the slot holds whatever the user wrote — `number` for the
linear-chain bench, `string` for label cells, `{ items: [...] }` for the
viewport row shape, `Map`/`Set` for collection cells. V8 sees a **single
LoadIC site** that observes wildly different value tag bits (Smi / HeapNumber /
String / Object). This is exactly the megamorphism risk the brief flags.

**However**, the IC here is loading a field off `Entry` (the pinned hidden
class), not off the value itself. V8 only goes megamorphic if the
**holder** shape varies; the loaded value's tag does not poison the LoadIC.
The downstream `as T` cast is type-erased. So the LoadIC stays monomorphic
across mixed-shape graphs. The cost — and it's real — is at the user's
call-site that consumes `read()`: if `read()` is called from a closure that
also reads other typed nodes, V8's return-value type feedback at the
caller's slot widens.

### Site 2 — `recordingGet` (graph.ts:2186)

```ts
function recordingGet<U>(n: Node<U>): U {
  const rec = activeRecording   // RecordingFrame | null
  ...
  if (dep.kind === 'derived') {
    if (rec.kind === 'iterative') { ... } else { ... }
  }
  ...
  const value = readEntryFromResolved(dep, n)
  ...
  return value as U
}
```

This is the per-`get()` accessor every derived `compute` body calls. It
dispatches on **two** discriminated unions back-to-back: `Entry.kind`
(input vs derived) and `RecordingFrame.kind` (recursive vs iterative).
The second discriminator is monomorphic *within a given driver
invocation* — the engine's own comment at line 2155 confirms V8 inlines
the branch — but it's bimorphic across the function's IC feedback. The
hot driver for linear-chain × 100 is `computeDerivedIterative`, so the
'iterative' arm dominates by ~99%.

### Site 3 — `Tx.set<T>` (graph.ts:3877 area)

```ts
set<T>(node: InputNode<T>, value: T): void
```

The `value` parameter is `T` — `number` for linear-chain, anything else
elsewhere. The body stores it into `e.value` (which is `unknown`). On the
write side this is fine: V8's StoreIC on a `unknown` field is always
monomorphic w.r.t. the holder. The `Object.is(e.value, value)` compare at
line 3911 / 3951 / 3959 is the only spot where value-shape feedback might
matter, and `Object.is` is a runtime built-in — not an IC site.

## Could splitting `Map<NodeId, Entry>` into homogeneous maps help?

**No.** The current single `entries: Map<NodeId, Entry>` is faster than
two maps for three reasons:

1. **`Entry` is a 2-element union of pinned hidden classes** (`InputEntry`,
   `DerivedEntry`) — V8 treats this as a bimorphic IC, which is just as
   fast as monomorphic for the kind-tag dispatch on `e.kind` at 1661.
2. **`getEntry(id)` is called BEFORE the `kind` check** by every hot-path
   read (1591). A two-map shape forces a "which map?" decision *before*
   the lookup — that decision requires the same `kind` tag the lookup is
   trying to discover. The split would need a third "id → kind" Map, or
   would force the caller to know the kind upfront (it doesn't —
   `recordingGet` accepts `Node<U>` without a polarity discriminator).
3. **The `dependents` reverse-dep Map (1204) and `disposed` tombstone
   Map (1229) are already keyed by the same `NodeId` namespace.** Adding
   a second forward-storage map would mean three Map probes per disposed
   read instead of two.

The split-Map pattern wins when the union arms have **different field
layouts** that cause hidden-class megamorphism on field loads. Here both
`InputEntry` and `DerivedEntry` have already been monomorphised
field-by-field (#915, #994, #995, #703 Win 5), so the storage shape
question is settled.

## Type-specialisation proposals

### Proposal A — Inline `readNumberFast` for the common Smi-only case

The linear-chain × 100 workload reads a `Node<number>` 100 times per
commit through `recordingGet`. Each call lands in the generic
`readEntryFromResolved` with the `as T` cast — V8 inlines this fine, but
the `as unknown as T` round-trip prevents the optimiser from tracking
that the returned value is a Smi (small int) end-to-end.

Adding a **non-generic** internal helper

```ts
function readEntryNumber(e: Entry, _: Node<number>): number {
  if (e.kind === 'input') {
    if (stagedActive && e.lastStagedAt === now) {
      return stagedWriteValues[e.lastStagedRow] as number
    }
    return e.value as number
  }
  if (e.kind === 'derived' && !e.computed) computeDerived(e)
  return e.value as number
}
```

and routing `recordingGet` through it **when the compute closure's
return type is provably `number`** would let V8's TurboFan track Smi
tags through the dep-resolution chain. The mechanism for "provably
number" is the issue: TS types are erased at runtime, so we'd need
either a sentinel on `DerivedEntry` (`numericOnly: boolean`) set at
`derived()` registration time when the compute returns a number on its
first evaluation, or a separate `derivedNumber(id, compute)` factory that
the bench harness uses. The harness already special-cases linear-chain
(causl.ts:186); making it call `derivedNumber` is a one-line bench
change.

Estimated impact on **linear-chain × 100**: trace-driven prediction
~3–6% commit-time reduction. Mechanism: 100 × (one less unbox/rebox
pair per `get(upstream) + 1` chain link). Net: removes 200 internal
type-tag widenings per commit. Real number contingent on V8 actually
sinking the Smi tag — needs `--print-opt-code` verification before
merge.

### Proposal B — Hoist `e.kind` test out of `recordingGet`

The `dep.kind === 'derived'` check at graph.ts:2198 runs on every
`get()` call. For a linear chain, **every** dep is derived except the
head input. V8 will see this as bimorphic (input on the leaf, derived
everywhere else) and the branch is cheap. But the second discriminator
on `rec.kind` (iterative vs recursive) is **also** in the same function
body, and the combined IC feedback at the call site grows.

Splitting `recordingGet` into two type-specialised inner functions

```ts
function recordingGetIterative<U>(n: Node<U>): U { ... }
function recordingGetRecursive<U>(n: Node<U>): U { ... }
```

and selecting one at driver entry (the driver knows its own kind)
removes the `rec.kind === 'iterative'` branch from the hot path
entirely. The two functions become single-purpose IC sites with one
fewer dispatch each.

Estimated impact on **linear-chain × 100**: ~2–4% commit-time reduction.
Mechanism: 100 × (one fewer property load + branch per `get()`). The
two new functions are ~30 lines each and share the dedup-loop body
(lines 2230–2243), which we'd extract into a `pushDep(rec, id)` helper.

### Proposal C — Specialise `setDepsFromArray` per-arity

Not a type-shape megamorphism win — different concern. Skip for this
audit; the current setDeps already early-returns on equal-size sets
(graph.ts:1785) and the linear-chain dep-set is always size-1 per
derived. Out of scope.

## Linear-chain × 100 estimated impact summary

| Proposal | Predicted Δ commit-time | Confidence | Risk |
| -------- | ----------------------- | ---------- | ---- |
| A — `readEntryNumber` specialisation | −3% to −6% | Medium (needs TurboFan verification) | Adds `derivedNumber` API surface |
| B — Split `recordingGet` by driver kind | −2% to −4% | Medium-high (mechanically straightforward) | Adds ~60 LOC, mild duplication |
| A + B combined | −5% to −9% | Medium | Compounding requires the same Smi-tag tracking to flow through both paths |

The brief asked where small per-call overhead matters most; linear-chain
× 100 has ~100 `get()` calls per commit and ~100 `read` returns per
commit publish. A 5ns/call saving across 200 IC sites is 1µs/commit —
visible on the `linear-chain-1k` profile diff (`packages/bench/report/
profiles/diff/causl-vs-jotai-linear-chain-1k.md`) but probably below
the bench harness's noise floor (±2% per the engine-status report).
Worth shipping if A and B together cross the 5% threshold; not worth
shipping either in isolation unless TurboFan output confirms the Smi
sinking.

## Recommendation

Land Proposal B first — it's mechanical, has no public-API surface,
and is verifiable with a `--print-opt-code` diff on `recordingGet`'s
optimised bytecode. If the diff shows the bimorphic `rec.kind` IC
collapsed to a monomorphic load on each new inner function, ship.
Then evaluate Proposal A against the post-B baseline; the Smi-tag
sinking is harder to verify and adds API surface, so it needs a real
bench delta to justify the additional surface.

No `Map<NodeId, Cell>` split is warranted — the storage shape is
already correct, and the discriminator union is bimorphic-with-pinned-
hidden-classes, which V8 inlines as well as a monomorphic site.
