# Hypothesis file format

EPIC-6 / TASK 6.4 (#510) — diagnostic output for the bounded
enumerator. When a hypothesis fails under the `causl-enumerate`
CLI binary, the enumerator writes a hypothesis-file (`.hypothesis`
JSON) capturing the failing trace + the shrunk counterexample so
adopters can replay the failure deterministically.

The file is the diagnostic counterpart of the SARIF result the
SARIF adapter emits — SARIF for code-scanning consumers, the
hypothesis-file for human debugging.

> **Current state (as of v0.9.0).** The wire format defined below
> is the v1 schema agreed for TASK 6.4. EPIC-6 (#468) and TASK 6.4
> (#510) shipped the schema + companion docs; EPIC-3 milestone-2
> (#535) shipped the `causl-enumerate` binary as a peer to
> `causl-check` (not as a `causl-check enumerate` subcommand — the
> earlier prose framing was superseded by the milestone-2 PR). The
> `--hypothesis-out` flag and the `@causl/hypothesis`
> `evaluateFromFile()` reader are still deferred follow-ons; the
> `causl-enumerate` CLI presently emits JSON / SARIF only and the
> `--seed` flag is wired through to `Bound` but does not yet
> consume a captured hypothesis-file. The schema is documented now
> so the emitter and reader land lockstep against a frozen v1
> shape.

## Schema

The file is a JSON document with a top-level shape:

```json
{
  "schema": 1,
  "tool": {
    "name": "causl-enumerate",
    "version": "<semver>"
  },
  "hypothesis": {
    "name": "<hypothesis-name>",
    "verdict": "fails",
    "predicate": "<expression>"
  },
  "trace": {
    "start": { "now": 0, "inputs": { ... }, "pending": [] },
    "steps": [
      { "action": { "kind": "...", ...}, "stateAfterHash": "<hex>" },
      ...
    ],
    "bound": { "kPrefix": 8, "kRandom": 2000, "depthCap": 96, "visitedCap": 1048576 }
  },
  "counterexample": {
    "shrunkFromSteps": <n>,
    "shrunkToSteps": <n>,
    "axisesShrunk": ["step-count"]
  },
  "racesAtFailure": [
    { "kind": "use-after-dispose", "node_id": "...", ... }
  ]
}
```

Schema versioning matches the IR pattern: `schema: 1` is the v1
shape; future bumps require lockstep updates to the enumerator's
emitter and the `@causl/hypothesis` evaluator's reader.

## SARIF integration

The hypothesis-file's `racesAtFailure` array maps 1:1 to SARIF
results emitted by `causl-enumerate --format sarif` (and by
`causl-check --format sarif` for the static-linter half of the
toolchain). Each `racesAtFailure` entry has the same `ruleId` as
the corresponding SARIF result; the hypothesis-file carries the
additional `trace` + `counterexample` detail SARIF doesn't
structurally model. Adopters who want both, once the
`--hypothesis-out` flag ships:

```bash
causl-enumerate --format sarif --hypothesis-out /tmp/hyp.json --input model.json
```

The SARIF goes to stdout; the hypothesis-file goes to the named path.

> **Current state (as of v0.9.0).** `causl-enumerate` today
> accepts `--input`, `--tier`, `--format` (`json` | `json-compact`
> | `text` | `sarif`), and `--seed`. The `--hypothesis-out` flag
> above is the documented target shape; until it ships, the SARIF
> stream alone carries `racesAtFailure`-equivalent results
> (without the `trace` + `counterexample` detail).

## Reproducibility

The hypothesis-file's `trace.start` + `trace.steps` are sufficient to
re-run the failure deterministically against the enumerator. The
seed is implicit — the enumerator's BFS is deterministic by design
(visited-set hash is blake3, action ordering is canonical), so a
captured trace replays under a fresh `causl-enumerate`
invocation byte-identical. (The CLI exposes a `--seed <32 hex>`
flag carried through to the `Bound` seed; once the emitter writes
the seed into the hypothesis-file, replay will be explicit rather
than implicit.)

## v1 status

This document defines the wire format. EPIC-3 milestone-2 (#535,
closed 2026-05-03) shipped the `causl-enumerate` CLI as a peer
binary to `causl-check`; the binary today emits JSON / SARIF
verdicts but does **not** yet write a `.hypothesis` file. The
enumerator emitter (`--hypothesis-out` flag) and the
`@causl/hypothesis` reader (`evaluateFromFile()` helper) remain
deferred follow-ons — they are intended to land lockstep against
this v1 schema. The original deferral pointer to #520 in the
first draft of this doc was incorrect (#520 turned out to be the
Apalache differential-test scaffold under TASK 4.5); a tracking
issue for the reader will be filed when the emitter work is
scheduled.
