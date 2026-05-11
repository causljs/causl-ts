# Theorem 1 (origin pinning) — static lint design note

EPIC-10 / TASK 10.5 (#522, closed). Design note for the
`causl-check` linter rule that would mechanize SPEC.async §3.1
Theorem 1 (`resource:origin-bound`). The deferral named here is
still in force as of v0.9.0.

## What Theorem 1 says

A fetch's resolved value lands on exactly the resource node it was
issued against. No cross-talk between resources.

## Why a static lint is hard

The resource state machine (Idle / Loading / Loaded / Stale /
Errored) is an adapter-level construct over `IRInput`. Its `origin`
field is part of the application payload, not part of the IR's
structural shape. The static linter walks the IR's structural shape
(nodes, deps, events); it does not see the resource state machine
directly.

To detect Theorem 1 violations statically, the IR would need:
1. A `kind: "resource"` discriminator on `IRInput` (rejected by §4
   two-primitive discipline; resources are roles, not kinds).
2. Or: an exporter-side projection that emits a sibling document
   alongside `CauslModel` documenting the resource state machine
   structurally. (Out-of-scope for v1; tracked for a future EPIC.)
3. Or: the bounded enumerator's runtime evaluator (EPIC-3
   milestone-2) drives the resource through its state machine and
   the runtime oracle catches the violation.

Path 3 is the chosen direction. The static `causl-check` linter
does NOT ship a `resource:origin-bound` rule today.

## Current state (as of v0.9.0)

The `causl-check` binary ships from `tools/checker/` (manifest
under `packages/checker/bin/causl-check.js`, platform-specific
binaries under `packages/checker-<triple>/bin/causl-check`), but
its rule set still does not include `resource:origin-bound`. The
`packages/causl-check/src/rules/resource-origin-bound.rs` rule the
SPEC.async §3.1 "Mechanical anchor" paragraph names as a forward
reference is not yet implemented; the static-IR side of that
mechanical anchor is a contract the linter has not yet picked up.
The deferral matches the path-3 plan above: the runtime evaluator
covers the contract, and the static lint waits on path 2 (the
exporter-side resource state-machine projection).

## Current witness

The runtime witness is the property test at:

  `packages/sync/test/properties/origin-bound-resolution.property.test.ts`

(SPEC.async §15.1 / EPIC-9 Property 2). The trial budget is
resolved through `tieredPropertyTrials('resource.origin-bound-resolution')`
(see PR #1097 / #1073, which shipped the tier-budget system); the
floor is the 1000-trial default from SPEC.async §15.2, with the
nightly tier widening the run. It catches Theorem 1 violations on
every CI run.

The unit-test witness is at:

  `packages/sync/test/theorems/theorem-1-origin-pinning.test.ts`

(EPIC-10). It pins the runtime contract.

## When the static lint becomes viable

The static lint becomes viable when path 2 lands — when an
exporter-side projection emits a structural document for the
resource state machine. That work is not currently scheduled; it
will be tracked under a follow-on EPIC if and when adopters request
it. The Rust-engine port (epic #1133, deferred post-0.9.0 with
GO/NO-GO criteria in the epic body) does not unblock path 2 on its
own — the resource state machine is an adapter-level construct
that lives above whichever engine substrate ships, and the
projection has to be authored either way.

Until then, this document is the design note explaining the
deferral. #522 closed with this acknowledgment; v0.9.0 ships
unchanged on the path-3 footing.
