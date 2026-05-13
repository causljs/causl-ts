# A.11 — File-split DECISION (defended reasons-to-change)

Per `docs/epic-1133/PLAN.md` §5 row A.11 — closes #1358.

This document is the DECISION artefact for A.11. The ticket is not an
implementation ticket: its deliverable is the table below plus the
defended verdict on whether to fold, rename, or keep each of the 8 files
under `tools/engine-rs-core/src/transition/`.

The lens is Metz on Reenskaug separation of concerns: a file deserves
to exist only if it has its own one-sentence reason-to-change. If any
two files share a reason — i.e. they would always change together for
the same trigger — they should fold. If a file's name doesn't match its
reason-to-change, it should rename.

The canonical naming reference is Engine-semantics cluster S5
(#1133 comment 4436792560): `validate / mutate / propagate / assemble /
historian / notify / dispose`. Of those names, only `validate` and
`mutate` map to Phase A files that exist today; the rest cover Phases
B-H, none of which is implemented. A.11 audits ONLY what exists.

## Defended reasons-to-change table

| File | Phase / ticket | One-sentence reason-to-change |
|---|---|---|
| `validate.rs` | A.1 + A.2 (#1338, #1151 engine half) | Changes when the **error-rejection surface widens or narrows** — e.g. adding a new precondition variant (`SchemaMismatchError`), retiring a guard (`tx_alive` removal post-#1151-style work), or re-ordering re-entrancy vs node-resolution priority. |
| `clock.rs` | A.3 (#1342) | Changes when **`GraphTime` mutation semantics** evolve — e.g. wrapping policy at the `u64::MAX` boundary, switching to a non-monotonic time-source, or splitting `now` into per-arm fields. |
| `mutate.rs` | A.4 + A.7 (#1133, #1350) | Changes when the **`tx.set` write-time decision shape** evolves — e.g. adding a third path (read-shadow, dependency-aware fast path), renaming the cell-side staging sentinels, or moving the fast-vs-slow dispatch rule. |
| `publish.rs` | A.5 (#1133) | Changes when the **staging→committed transfer protocol** changes — e.g. retrofitting the `Object.is` cutoff to apply uniformly across both paths, altering the rollback-buffer triple shape, or rewriting `is_same_value`'s SameValue table. |
| `rollback.rs` | A.6 (#1348) | Changes when the **catch-arm atomicity-restoration contract** widens — e.g. adding a derived-rollback walk for Phase D, changing the order between cell-restore and sentinel-clear, or moving the `now = before_now` step relative to the buffer walk. |
| `compact.rs` | A.8 (#1352) | Changes when the **in-tx fast-path revert-cancel algorithm** evolves — e.g. extending compaction to the slow-path buffer (if A.5's publish-time filter ever moves), adding a memo-invalidation hook (if a `serializable_memo` lands), or changing the survivor-id push order. |
| `stamp.rs` | A.9 (#1354) | Changes when the **`last_write_time` semantic** evolves — e.g. switching from per-tx to per-cell stamp choice, adding a per-dep `contributedAt` stamp for derived frames, or moving the stamp call relative to publish/compact. |
| `typestate.rs` | A.10 (#1356) | Changes when the **phase ordering itself** changes — e.g. inserting a new sub-phase between B and C, splitting `PhaseCDot5` into stamp+notify, or making `publish` actually fallible (today the `Err` arm is wired but unused). |

Eight files, eight reasons. No pair shares a sentence.

## Paraphrase audit — the four scrutiny pairs

Per the ticket brief, four pairs deserve explicit scrutiny because they
LOOK like they could share a reason-to-change. The audit verdict on
each:

### `publish.rs` vs `compact.rs` — both touch the rollback-row lifecycle

Surface similarity: both files manipulate a rollback buffer. But the
*reason* one would change is distinct:

- `publish.rs` changes when the **staging→committed transfer
  protocol** changes. Its defining behaviour is the Phase B `Object.is`
  cutoff applied AT WRITE TIME, and the captured pre-image triple as a
  side-effect of survival. Without `publish.rs`, `compact.rs` has
  nothing to walk.
- `compact.rs` changes when the **fast-path revert-cancel algorithm**
  evolves. Its defining behaviour is the post-write filter that
  observes the *final* cell value after a sequence of fast-path writes
  and drops rows whose net effect is a no-op. The publish-time
  Object.is filter cannot do this work because the fast path doesn't
  publish through staging at all — it writes inline and captures
  unconditionally, so the post-tx filter has to run elsewhere.

The two would only fold if Phase A.5 compaction were merged into the
publish-time cutoff (i.e. the fast path stopped writing inline). That
is a different decomposition of the engine — not the current shape and
not what S5's naming proposes. **Keep distinct.**

### `mutate.rs` vs `publish.rs` — staging-time vs publish-time write

Surface similarity: both files write through the engine's mutation
surface. Reasons-to-change are cleanly separated by phase:

- `mutate.rs` changes when the **`tx.set` write-time decision shape**
  evolves. It hosts the per-write dispatch (fast vs slow), the
  slow-path staging-buffer push, and the fast-path inline write +
  rollback-row capture.
- `publish.rs` changes when the **staging→committed transfer
  protocol** changes. It hosts the Phase B drain loop and the
  publish-time `Object.is` filter that converts staged writes into
  cell mutations.

A change to the slow-path staging shape (new sentinel field, dispatch
rule) leaves the publish protocol untouched, and vice versa. **Keep
distinct.**

### `stamp.rs` vs `clock.rs` — both touch `GraphTime`

Surface similarity: both files write a `GraphTime` value somewhere.
Different reasons-to-change, different mutation targets:

- `clock.rs` changes when **`now` mutation semantics** evolve. It
  writes ONE `u64` on State — the global clock. The invariant is
  monotonicity.
- `stamp.rs` changes when the **per-cell `last_write_time` rule**
  evolves. It writes N values on N cells, gated by the rollback-survivor
  set. The invariant is "cells absent from the survivor set are NOT
  touched".

A change to clock wrapping policy doesn't change which cells get
stamped; a change to the survivor-set definition doesn't change how
`now` advances. **Keep distinct.**

### `rollback.rs` vs `compact.rs` — throw-arm vs success-arm filter

Surface similarity: both files walk a fast-path rollback buffer.
Reasons-to-change diverge on which arm fires:

- `rollback.rs` changes when the **throw-arm atomicity contract**
  widens. It runs ONLY on the error path; its consumers are catch
  blocks at Phase B and beyond. The contract it pins is SPEC §3
  Theorem 3 (atomicity): `State::hash()` byte-identical before and
  after.
- `compact.rs` changes when the **success-arm revert-cancel filter**
  evolves. It runs ONLY on the success path; its consumer is the
  Phase B publish that follows. The contract it pins is SPEC §3 /
  #987 (`changed_nodes` excludes net-no-op writes).

A change to the atomicity walk-order (e.g. reverse-order) doesn't
affect what compact filters; a change to the revert-cancel predicate
doesn't affect what rollback restores. **Keep distinct.**

## Rename audit vs S5 canonical naming

S5's proposed 7-file split: `validate / mutate / propagate / assemble /
historian / notify / dispose`. Per-file decision:

| Current name | S5 name? | Decision | Defense |
|---|---|---|---|
| `validate.rs` | `validate` | KEEP NAME | Direct match. The file's reason-to-change is precisely S5's `validate` scope. |
| `clock.rs` | n/a (no S5 file) | KEEP NAME | S5 folds clock advance into `assemble`. But the clock has its own one-sentence reason (monotonicity of `now`) distinct from any commit-record assembly. Folding into a not-yet-existing `assemble.rs` would mix the clock's invariants with the commit-log shape — different reasons-to-change. KEEP. |
| `mutate.rs` | `mutate` | KEEP NAME | Direct match. A.4 + A.7 are the slow- and fast-path arms of the same `tx.set` dispatch — both change when "write-time decision shape" evolves. |
| `publish.rs` | could rename to `propagate.rs` | KEEP NAME | S5's `propagate` is Phase D Kahn recompute — a fan-out concept. `publish.rs` is staging→cell *transfer* with an Object.is filter. Renaming would mis-name: when `propagate.rs` actually lands for Phase D it will be a distinct file with a distinct reason-to-change (the recompute order / topology). The current `publish.rs` deserves to keep its accurate name. |
| `rollback.rs` | n/a (no S5 file) | KEEP NAME | S5 has no rollback module — atomicity restoration is implicit in S5's view. But the throw arm has its own one-sentence reason (SPEC §3 Theorem 3) and one consumer (catch arms from Phase B onward). Folding into `validate.rs` would mix "reject-on-precondition-fail" with "restore-on-mid-tx-throw" — two distinct error surfaces with two distinct restoration rules. KEEP. |
| `compact.rs` | n/a (no S5 file) | KEEP NAME | S5 has no compaction module — its 7-file decomposition implicitly assumes the publish-time filter handles ALL revert-cancels. That assumption is false in the current Rust port because the fast path bypasses staging. Folding into `mutate.rs` would force `mutate.rs` to know about Phase B's `is_same_value` predicate (today imported only from `publish.rs`), expanding its reason-to-change to include "the fast-path's net-no-op detection rule". KEEP. |
| `stamp.rs` | n/a (no S5 file) | KEEP NAME | S5 folds stamp into `assemble`. But the stamp has its own one-sentence reason (per-cell `last_write_time` rule) and runs over a DIFFERENT id set than either of the buffers `assemble` would consume — it walks both rollback buffers' `entries` and writes nothing else. Folding into `publish.rs` would couple Phase B's publish protocol to Phase C.5's stamp rule; they evolve independently. KEEP. |
| `typestate.rs` | n/a (no S5 analogue) | KEEP NAME | Pure type-level orchestrator. S5 has no analogue because S5's 7-file split is at the *body* level (one file per phase body); the typestate is the meta-level glue that wires the bodies into a phase machine. It is structurally distinct and cannot fold into any phase body. KEEP. |

## Verdict — all 8 files survive

**No folds. No renames.** Every file has a defended one-sentence reason
that distinct from every other file's. The four scrutiny pairs the
brief flagged (publish/compact, mutate/publish, stamp/clock,
rollback/compact) were specifically examined and the audit confirms
they manipulate the same low-level entities (rollback buffers, clock,
cell mutations) at different *phase boundaries* with different
*contracts*.

The S5 naming audit asks whether any current name would be more
accurate under S5's vocabulary; the audit verdict is no. `publish.rs`
is NOT `propagate.rs` (the latter, when it lands for Phase D, is the
Kahn recompute fan-out — a different concept). `clock.rs`,
`rollback.rs`, `compact.rs`, `stamp.rs`, `typestate.rs` have no S5
analogue and renaming them to fit S5 would lose information.

## Files the audit chose NOT to pre-create

S5 names `propagate`, `assemble`, `historian`, `notify`, `dispose` for
Phases B-H. A.11 explicitly DOES NOT pre-create them — they would be
empty stubs today, polluting the module tree with files whose
reasons-to-change are speculative. They land when the phase they
encode lands.

## Acceptance — no implementation change

A.11 is a decision ticket. The PR carrying this document changes only
this file (and the surrounding `mod.rs` / source comment references if
needed). No code under `tools/engine-rs-core/src/transition/` is
renamed or merged. `cargo test -p causl-engine-core` and `pnpm
validate` pass without modification — they would not be able to anyway,
because no test references this doc.
