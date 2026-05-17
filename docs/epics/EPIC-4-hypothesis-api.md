# EPIC: Hypothesis API (`packages/hypothesis/` package)

**Status (as of v0.9.0): SHIPPED.** Epic tracker [#469](https://github.com/iasbuilt/causl/issues/469) closed 2026-05-03; all five tasks merged (TASK 4.1 [#516](https://github.com/iasbuilt/causl/issues/516), TASK 4.2 [#517](https://github.com/iasbuilt/causl/issues/517), TASK 4.3 [#518](https://github.com/iasbuilt/causl/issues/518), TASK 4.4 [#519](https://github.com/iasbuilt/causl/issues/519), TASK 4.5 [#520](https://github.com/iasbuilt/causl/issues/520)). The `@causl/hypothesis` package is live at `packages/hypothesis/` with the §16.5.1 combinator surface, the three-axis shrinker, and the Apalache differential runner. Phase-8 audit follow-ons closed the §16.5.1 completeness gap ([#571](https://github.com/iasbuilt/causl/issues/571)) and the combinator gaps for `afterCommit` / `atStart` shrink axes / three-valued `evaluate` semantics ([#588](https://github.com/iasbuilt/causl/issues/588)).

**Divergence from this design doc (current state, v0.9.0):** the shipped source layout collapsed onto a flat module structure rather than the directory-per-combinator layout described under "Package layout". Current files: `packages/hypothesis/src/{index.ts, types.ts, evaluate.ts, combinators.ts, shrink.ts, apalache.ts}` plus tests under `packages/hypothesis/test/`. The combinators live in a single `combinators.ts` file rather than the `combinators/{always,eventually,until,…}.ts` per-file split this doc anticipates; the shrinker is a single `shrink.ts` rather than `shrink/{actions,nodes,step}-pass.ts`. The acceptance-test layout also diverged: tests are named `spec-16-5-1-*.test.ts` (factory, commit-matcher, during-phase, fixes) and `combinators.test.ts` / `shrink-*.test.ts` rather than the per-file mirror this doc specifies. This document is preserved as design archaeology — the design rationale below remains the rationale, but consult the source for the as-shipped file layout.

**Spec anchors:** §16.5, §16.5.1, §16.5.2.

**Risk:** LOW — new package, devDependency-only, never ships in production bundles. The wire format the Rust enumerator emits is consumed here as plain JSON; nothing in this package can corrupt an adopter's runtime, because nothing in this package is loaded by an adopter's runtime. The blast radius if we ship a bug is "a hypothesis file fails closed when it should fail open, or open when it should fail closed", and the Apalache differential corpus (TASK 4.5) is exactly the gate that catches that class of bug before the adopter sees it. The package's `package.json` carries `"private": false`, `"sideEffects": false`, and no `dependencies` other than the shared `@causl/types` types-only package; runtime deps stay at zero so the install footprint stays trivial.

**Dependencies:** EPIC-3 (bounded enumerator) — the hypothesis runtime is what the enumerator evaluates against. The `Trace<S>` shape this package consumes is what the enumerator emits, and the field names (`steps`, `phase`, `justFired`, `justCommitted`, `lastCommit`) are pinned in §16.5.1. EPIC-1 (Schema 3 IR) — indirectly via EPIC-3, since the enumerator's wire format is the schema-3 IR plus the per-step `PhaseStep` discriminator §16.5.1 names. Soft dependency on EPIC-7 (Apalache corpus) for TASK 4.5's full integration test, with a 2-model in-package mini-corpus filling in until EPIC-7 lands.

## What I'm shipping

Lamport opens §16.5.1 with the line we are building toward: "A specification is a behavior that is allowed; everything else is forbidden." The whole package collapses into that sentence. An adopter writes a `hypothesis(name, body)` value in TypeScript; the enumerator (EPIC-3) hands us a `Trace<S>`; we walk the trace and return a `Verdict<S>` that is either `{ kind: 'pass' }` or `{ kind: 'fail'; step; witness; reason }`. The combinators — `always`, `eventually`, `holds(p).until(q)`, `afterCommit`, `during`, `never`, `implies`, `and`, `or` — are the vocabulary the adopter writes sentences in. The vocabulary is closed; the sentences are the adopter's. That split is the whole reason the package exists. We are not in the business of guessing what an adopter wants to assert about their state machine; we are in the business of giving them nine well-typed, well-documented verbs and getting out of the way.

Beck's framing is the load-bearing reason these are TypeScript values an adopter writes by hand, not a YAML DSL or a generated stub. The test is the oracle. An oracle the adopter cannot read, the adopter cannot trust, and we have watched four projects discover that the property suite the adopter does not read is the property suite the adopter routes around at the first red CI run. So the hypothesis file is a TypeScript program — typed, autocompleted, refactorable, reviewable — and the combinators are functions a TypeScript developer can step into in a debugger and watch evaluate. When a CI run fails with `until: p failed at step 7 before q held` and a witness state pinning `s.app.cellId === 4 && s.app.inputId === 2`, the adopter does not need to read the package source to understand what went wrong; the verdict is the explanation.

Hejlsberg's contribution to the API surface is the `S` generic threaded through every signature. A predicate over `State<MyApp>` does not silently widen to `State<unknown>` because the user passed a callback that returned `any`; the `Predicate<S>` type forces the call site to be honest about what it is reading from `state.app`. Every public function — `hypothesis<S>`, `always<S>`, `eventually<S>`, `holds<S>`, `afterCommit<S>`, `during<S>`, `never<S>`, `implies<S>`, `and<S>`, `or<S>` — carries `S` as the only generic parameter, and TypeScript's inference threads it through composition without the adopter ever typing `<S>` after the initial `hypothesis<MyApp>(...)`. The `// @ts-expect-error` test row in TASK 4.1 is the gate that this inference does not silently break.

The Verdict shape (§16.5.1) is a closed two-arm tagged union with `assertNever` at every consumer. `{ kind: 'pass' }` carries no payload because the question "why did this pass" is uninteresting; `{ kind: 'fail'; step: number; witness: State<S>; reason: string }` carries the three pieces the adopter needs at the call site. `step` is the index into `trace.steps` where the violation fires — the shrinker's earliest-step axis is defined relative to this number. `witness` is the full `State<S>` at that step, including `state.graph`, `state.app`, `state.lastCommit`, so the adopter can read out any application-level field the predicate referenced. `reason` is a uniform string the SARIF emitter and the CLI formatter both consume; every combinator follows the same `'<combinator>: <what failed> at step <index>'` shape so an adopter scanning a CI log can grep `always:` or `until:` and find the failures from that combinator class. The uniformity is intentional: SARIF rule metadata groups by the prefix, and the CLI's `--filter-combinator always` flag is a substring match.

The three-axis shrinker (§16.5.2) is the part adopters will judge the tool on. Pass 1 delta-debugs the action sequence — fewest actions. Pass 2 drops or merges nodes — fewest distinct nodes. Pass 3 truncates the prefix — earliest violating step. The outer loop iterates until no pass makes progress on any axis. The shrinker invariant — every shrunk trace still violates the predicate — is enforced by re-running the hypothesis after every reduction; if a shrunk trace passes, we throw `shrinker invariant violated` at the call site, because a silent shrinker bug is a worse failure mode than a loud one. A 50-event reproducer for a row-7 dynamic-dep cleanup race shrinks to ≤5 events; that target is §16.6's milestone-4 acceptance criterion and we own it here. The Apalache differential-test scaffold (TASK 4.5) closes the loop: when the corpus is at 10/10 agreement on 47/47 properties, the enumerator is as trustworthy as the corpus is broad, and the corpus's breadth is reviewable in one sitting. Beck's "two oracles, one truth" — neither Apalache nor the Rust enumerator is the truth; the truth is the conjunction of their agreement plus the named exceptions.

## Brutal-critical review

Where the design is risky, in order of how much sleep we are losing over each:

**The combinator names.** `holds(p).until(q)` is fluent; `until(p, q)` would be more functional and would compose more cleanly with `and`/`or`. We picked fluent for readability — the adopter writes `holds(s => s.invariant).until(s => s.justFired('commit'))` and reads it left-to-right as English, the way they would write it on a whiteboard. The cost: `until` cannot be passed by reference the way `always` can. `const u = holds(p).until` is a `TypeError` because `until` is a method that closes over `p`. Hejlsberg pushed for the functional form; Lamport sided with fluent because TLA+ readers think in `p U q`, not in `until(p, q)`. We accept the friction; if adopters complain in the first three months post-ship, we add a functional alias `until<S>(p: StepPredicate<S>, q: StepPredicate<S>): Predicate<S>` that delegates to `holds(p).until(q)`. The alias is a one-liner; we do not pre-build it.

**The Verdict shape carries a `reason: string` — uniform across combinators.** Every combinator emits a string. What if a future combinator wants structured reason data — a list of nodes, a timing diagram, a sub-trace? Today's answer: it doesn't, because every combinator's failure shape is "predicate failed at step N with witness W" and the string is enough to disambiguate which combinator and which sub-clause. If a future combinator needs structured payload, we extend `Verdict` to `{ kind: 'fail'; step; witness; reason: string; details?: VerdictDetails }` where `VerdictDetails` is a `#[non_exhaustive]`-style discriminated union. We do not pre-build that; YAGNI. The test suite for TASK 4.1 includes a forward-compatibility test that adding an optional `details?` field is a non-breaking change for downstream consumers (the SARIF emitter, the CLI formatter, and the shrinker all destructure on `kind | step | witness | reason` and ignore extra fields).

**Shrinker passes are sequential (actions, then nodes, then step); could a later pass undo a previous?** Yes — Pass 3 (prefix truncation) can re-introduce nodes that Pass 2 dropped, if the truncation moves the violation to a step where the dropped nodes were not yet referenced. The outer-loop fixpoint catches this: Pass 1 runs again on the truncated trace, then Pass 2, then Pass 3. The fixpoint guarantee deserves a property test, and we own that test in TASK 4.4 — 1000 random failing traces, assert convergence within ≤20 outer iterations. If a trace fails to converge in 20 iterations we treat that as a shrinker bug, not as "needs more iterations". The 20-iteration ceiling is conservative; in practice traces converge in 3-5 outer iterations on the corpus we have measured against.

**Apalache as a tiny-corpus oracle (10 models). Why not 100?** Maintenance cost. A TLA+ model takes a working week to write, review, and pair with a Rust scenario and a `mapping.toml` entry. Ten models is what we can keep current as the enumerator evolves. A hundred models is what we would get if we let the corpus rot for a year; the differential test would be running against models whose semantics no longer match the enumerator's semantics, and the test would either go red on every PR (and get disabled) or go green by accident (and stop catching divergence). Ten models, reviewed in one sitting, kept current — that is the deal. If the corpus needs to grow, EPIC-7 owns the growth, not this EPIC. We have heard the argument "but Apalache is automated, we can run 1000 models" — Apalache's `apalache-mc check` on a non-trivial model takes 30-90 seconds, and 1000 models is 8-24 hours of CI per PR. Ten models is 5-15 minutes. The CI budget pins the corpus size more than the TLA+ author's time does.

**The `setup: SetupFn<S>` runs once per trace; can side effects in setup bleed across traces?** They cannot, because the engine the setup runs against is a fresh `Engine` per trace, instantiated by the enumerator. But adopters will write setups that call `Math.random()` or `Date.now()`, and those calls will produce different values per trace, and the trace will not be reproducible from `seed` alone. We document this loudly in the package README and in the type doc on `SetupFn<S>`: setup must be deterministic in `engine` alone. We do not enforce it at the type level — there is no TypeScript way to forbid `Math.random()` inside a callback — but the test in TASK 4.2 includes a determinism check that runs setup twice and asserts identical resulting `S`. If the adopter ships non-deterministic setup, that test catches it the moment the adopter writes a hypothesis that depends on `s.app` carrying the setup output. We considered a runtime guard that intercepts `Math.random` and `Date.now` during setup; rejected because it would require monkey-patching globals and would surprise adopters whose setup legitimately reads the wall clock for unrelated reasons.

**Generic parameter `S` threading is load-bearing for the API surface but invisible at the call site.** Hejlsberg's concern: an adopter writes `hypothesis<AppState>(...)` once and never types `S` again; every combinator infers it. If inference fails — say, the adopter passes a callback that returns `any` — the failure mode is `Predicate<unknown>`, not a compile error. We mitigate with a `// @ts-expect-error` test that confirms `Predicate<unknown>` is rejected when assigned to `Predicate<AppState>`. The adopter sees a type error at the assignment site, not a silent widening. This is the kind of thing tsc gets right and we lean into.

**Empty-trace edge case in `eventually` and `until`.** What does `eventually(p)` return on a zero-step trace? §16.5.1's reference implementation reads `trace.steps[trace.steps.length - 1]` which is `undefined` on an empty array, producing a fail verdict with `witness: undefined` — a runtime crash on the witness field's downstream consumers. We pin the behavior: the runner in TASK 4.2 short-circuits on `trace.steps.length === 0` with a verdict carrying `reason: 'empty-trace'` and a synthetic witness pinned to a sentinel state the runner injects. The combinators themselves never see an empty trace. This is a contract between the runner and the combinators that we document at both ends.

**`afterCommit` matcher semantics.** `CommitMatcher` has three fields: `touches?: string`, `tag?: string`, `any?: true`. Today the matcher is OR-of-fields: a commit matches if it touches the named node OR carries the named tag OR `any` is true. We considered AND semantics (all named fields must match) and found they were unworkable for the common case `afterCommit({ touches: 'inputId' }, p)` where the adopter does not know or care about tags. OR semantics is what §16.5.1 implies; we pin it. An adopter who wants AND writes `and(afterCommit({ touches: 'inputId' }, p), afterCommit({ tag: 'user-driven' }, p))`. Awkward, and we will revisit if adopters ask for it.

**The `touches: string` matcher is keyed on a node identifier the adopter typed at setup time.** That identifier is what `setup` returns inside the `S` payload — `setup` returns `{ inputId: engine.input(0) }` and the matcher's `touches: 'inputId'` is the field name on `S`, not the node's runtime ID. The matcher implementation reads `body.setup`'s return value to resolve the field name to a node ID, then matches commits against that ID. This means the matcher is type-checked against `keyof S` at the type level: `touches: 'inputI'` (typo) is a tsc error because `'inputI'` is not a key of `{ inputId: NodeId }`. Hejlsberg's contribution again — the type-level keyof is what makes this safe. The cost: `touches` cannot be a runtime-computed string; it must be a literal that tsc can check against the inferred `S`. We accept this restriction.

**Reason-string formatting is split between the combinator and the formatter.** The combinator emits a structured string like `until: p failed at step 3 before q held`. The CLI formatter and the SARIF emitter both parse this string back into structured fields for display. We considered emitting structured `reason` (an object) and rendering it at the consumer; rejected because (a) it bloats the verdict shape and (b) the string format is the wire format the differential test (TASK 4.5) compares against. A future change that wants structured reason data adds the `details?: VerdictDetails` field per the brutal-critical above; the string stays as the human-readable summary. The string format is documented in `packages/hypothesis/REASONS.md` as a non-normative reference for downstream consumers.

**The `setup` callback receives an `Engine` instance the enumerator constructs.** That `Engine` is the same shape as the runtime `@causl/core` engine but bounded by the `Bound` parameter (max nodes, max commits, max async depth, max msg fanout). Adopters can call `engine.input(...)`, `engine.derived(...)`, `engine.subscribe(...)`, etc., and the engine bounds-checks the operation; exceeding a bound throws `BoundExceededError`. The error is caught by the enumerator and translated to a `bound-exceeded` verdict that the differential test recognizes. We considered exposing the bounds at the setup level (an adopter could query `engine.maxNodes`); rejected because it leaks the enumeration strategy into the adopter's setup, and we want the bounds invisible at the call site. If an adopter needs to know the bounds, they read `body.bound` directly.

**The `during` combinator and async phases.** `during('commit-resolve-async', p)` is the canonical use cited in §16.5.1, and the async phase has no fixed step count — it iterates over pending resolutions. An adopter writing `during('commit-resolve-async', s => s.graph.everyResourceIsResolvable())` is asserting the predicate at every step in the async phase, which on a bounded enumeration could be 0, 1, or `maxAsyncDepth` steps. The combinator's behavior on a 0-step async phase is vacuous pass; we document this and the test exercises the edge case explicitly. The shrinker's prefix-truncation pass interacts with the async phase: truncating a prefix that contained an async resolution can shift later async steps to earlier indices, which can change the `during` evaluation count; we test this composition in TASK 4.4.

**The package's TypeScript module-resolution shape.** `packages/hypothesis/package.json` exposes `exports` map with `"."` pointing at `dist/index.js` (built) and `"./internal"` for the test-only types the differential runner exercises. The `internal` export is documented as unstable; consumers who import from `internal` accept that the contract can change between minor versions. All adopter-facing imports go through the root export and stay stable.

## Sub-issues (TASKS)

### TASK 4.1 — Core types: `Trace<S>`, `Step<S>`, `State<S>`, `Verdict<S>`, `Predicate<S>`, `StepPredicate<S>`

**Files:** `packages/hypothesis/src/types.ts`, `packages/hypothesis/src/freeze.ts`, `packages/hypothesis/src/serialize.ts`, `packages/hypothesis/test/types.test.ts`, `packages/hypothesis/test/types.test-d.ts`, `packages/hypothesis/test/serialize.test.ts`.

The pure-data layer. Every other task in this EPIC consumes these types. They land first because the enumerator (EPIC-3) emits `Trace<S>` as the wire format that crosses the Rust/JS boundary, and we want the types pinned before either side starts writing serializers. The wire format is JSON; the in-memory shape is JSON-plus-callable-helpers (`state.justFired(e)`, `state.inPhase(p)`); `freeze.ts` walks the deserialized JSON and attaches the helpers; `serialize.ts` is the inverse, stripping helpers for transport.

#### TDD test suite (≥5 tests)

- **Type-d test (`types.test-d.ts`)** — `Verdict<unknown>` is `{ kind: 'pass' } | { kind: 'fail'; step: number; witness: State<unknown>; reason: string }`. The `assertNever` switch in `formatVerdict()` produces a tsc error if we add a third arm without updating the formatter. Test: introduce a phantom `{ kind: 'pending' }` arm in a fixture and assert `tsc --noEmit` fails with `Argument of type 'pending' is not assignable to parameter of type 'never'`.
- **Type-d test (`types.test-d.ts`)** — `Predicate<S>` is `(trace: Trace<S>) => Verdict<S>`; assignment from `StepPredicate<S>` (which is `(state: State<S>, index: number) => boolean`) is REJECTED at the type level. Test: `// @ts-expect-error` on `const p: Predicate<MyApp> = (s, i) => true`. If the expect-error suppression is not needed, tsc fails the test.
- **Type-d test (`types.test-d.ts`)** — `Predicate<MyApp>` is NOT assignable to `Predicate<unknown>` and vice versa. Test: `// @ts-expect-error` on `const p: Predicate<unknown> = always<MyApp>(s => s.app.cellId === 0)`. The widening is forbidden because `unknown.app` is `unknown` and the predicate body would not typecheck.
- **Type-d test (`types.test-d.ts`)** — `Trace.steps`, `Step.justFired`, `Step.justCommitted` are all `readonly`. `// @ts-expect-error` on `trace.steps.push(step)`, `step.justFired.add('e')`, `step.justCommitted.push(c)`. All three must produce tsc errors.
- **Runtime test (`types.test.ts`)** — `Trace.steps[0].state.justFired('commit')` returns a boolean. Construct a fixture trace where step 0's `justFired` set contains `'commit'`, assert the call returns `true`. Construct a second fixture where the set is empty, assert `false`. Construct a third where we call `justFired('not-an-event-name-the-engine-emits')` and assert `false` (the function does not throw on an unknown name; it returns the absence answer).
- **Runtime test (`types.test.ts`)** — `Trace.steps` is frozen at runtime. `Object.isFrozen(trace.steps)` is `true` after `freeze(deserialize(json))`. An attempted `(trace.steps as Step[]).push(extra)` throws `TypeError: Cannot add property ...` in strict mode and silently no-ops in sloppy mode (we accept the sloppy-mode no-op because the type-level guard is the primary gate; the runtime freeze is defense in depth).
- **Runtime test (`types.test.ts`)** — `state.inPhase('idle')` returns `step.phase === 'idle'`. Construct a trace with a known phase distribution; for each step, assert `state.inPhase(p)` agrees with `step.phase === p` for every `p` in the seven-element `PhaseStep` enum.
- **Property test (`serialize.test.ts`)** — a `Trace<S>` produced by a fixture generator round-trips through `JSON.stringify` / `JSON.parse` followed by `freeze` without value drift. The `state.justFired` and `state.inPhase` callable methods are reconstructed by the deserializer (they cannot survive raw JSON; the deserializer rebuilds them from the `justFired: ReadonlyArray` payload, since `Set` is not JSON-serializable and the wire format uses arrays). Property: for 1000 random traces, `freeze(deserialize(serialize(t)))` produces a trace whose every `step.state.justFired(e)` returns the same boolean as the original for every `e` in the original's fired set, and whose every `step.state.inPhase(p)` agrees on every `p` in `PhaseStep`.
- **Type-d test (`types.test-d.ts`)** — `PhaseStep` is the closed union `'idle' | 'commit-prepare' | 'commit-resolve-async' | 'commit-fanout' | 'commit-finalize' | 'msg-dispatch' | 'msg-fanout'`. A switch over `phase` with `assertNever` in the default arm produces a tsc error if a new arm is added without updating the switch. Test: introduce a phantom `'commit-rollback'` arm in a fixture file and assert tsc fails the test build.
- **Forward-compat test (`types.test.ts`)** — adding an optional `details?: unknown` field to the `fail` arm of `Verdict` does not break existing consumers. Test: construct a `Verdict` with `details: { extra: 'data' }`; pass it through the formatter and the SARIF emitter (mocked); assert both consumers ignore the field and produce identical output to a verdict without the field.

A representative fixture trace under `packages/hypothesis/test/fixtures/types/three-step-trace.json`:

```json
{
  "bound": { "maxNodes": 4, "maxCommits": 2, "maxAsyncDepth": 1, "maxMsgFanout": 2 },
  "seed": 42,
  "steps": [
    { "index": 0, "phase": "idle", "justFired": [], "justCommitted": [],
      "state": { "graph": { "nodes": [], "edges": [] }, "app": {}, "lastCommit": null } },
    { "index": 1, "phase": "commit-prepare", "justFired": ["commit"], "justCommitted": [],
      "state": { "graph": { "nodes": ["n0"], "edges": [] }, "app": { "cellId": "n0" }, "lastCommit": null } },
    { "index": 2, "phase": "idle", "justFired": [], "justCommitted": [{ "id": "c0", "touches": ["n0"] }],
      "state": { "graph": { "nodes": ["n0"], "edges": [] }, "app": { "cellId": "n0" }, "lastCommit": { "id": "c0", "touches": ["n0"] } } }
  ]
}
```

The deserializer reads this JSON, walks the `steps` array, and for each step constructs a `State<S>` where `state.justFired = (e) => step.justFired.includes(e)` and `state.inPhase = (p) => step.phase === p`. The closure captures the step's `justFired` array by reference; the test asserts `Object.isFrozen(step.justFired) === true` so a malicious or buggy consumer cannot mutate the captured array and observe a different return value.

#### 5 concerns

1. **Generic parameter `S` threading.** Every combinator preserves `S`. A predicate over `State<MyApp>` does not silently widen to `State<unknown>` because a callback returned `any`. The test-d suite covers the `// @ts-expect-error` cases; the runtime suite confirms that `s.app` reads typecheck against the declared `S`. Hejlsberg's concern is that inference can fail silently when an adopter's IDE does not surface the inferred type; we mitigate with explicit type annotations on every public combinator return type.
2. **Readonly discipline.** `Trace.steps`, `Step.events`, `Step.justFired`, `Step.justCommitted`, `State.graph`, all `readonly` at the type level. Mutations are TS errors. The runtime layer freezes every trace with `Object.freeze` at construction; an attempted mutation in non-strict-mode JS silently no-ops, in strict mode throws. We accept silent no-op for adopter scripts that opt out of strict mode; the type error is the primary gate. Defense in depth: every public consumer treats inputs as immutable and never mutates.
3. **JSON round-trip.** Every `Step` is serializable. The `state.justFired` callable on `State<S>` is reconstructed from a serialized `justFired: string[]` payload by the deserializer, not preserved as a function. The serializer tests cover this end-to-end so the SARIF emitter (TASK 4.5 indirectly, via the diff scaffold) and the differential test (TASK 4.5) consume the same wire format. The wire format is documented in `packages/hypothesis/WIRE.md` as a non-exported reference; the format is owned by EPIC-3 (the enumerator) and pinned here.
4. **PhaseStep enum closure.** Every `Step.phase` is one of seven literal strings. The default arm of every switch over `phase` is `assertNever(phase)` so a future enum extension is a compile error at every call site. The seven names are pinned in §16.5.1 and we audit any addition through a §16.5.1 spec amendment.
5. **No race condition.** Types are pure data. There is no concurrent mutation hazard at the type layer because the types do not own any mutable state. Adopters who pass the same `Trace` to multiple `hypothesis.run` calls in parallel get correct behavior because the trace is frozen and the runner produces no side effects against it.

### TASK 4.2 — `hypothesis(name, body)` factory + `Hypothesis<S>.run(trace)`

**Files:** `packages/hypothesis/src/factory.ts`, `packages/hypothesis/src/run.ts`, `packages/hypothesis/test/factory.test.ts`, `packages/hypothesis/test/run.test.ts`, `packages/hypothesis/test/run-property.test.ts`.

The factory and the runner. Per §16.5.1, `run` walks every step, fail-fasts on `invariant` returning false (with `reason: 'invariant-violation'`), then evaluates `body.predicate(trace)` and returns its verdict. The split between `invariant` and `predicate` is the same split TLA+ draws between the safety part of `Spec` (invariants per step) and the temporal-formula part (predicate over the whole trace) — Lamport's framing, repeated here because the implementation is exactly that split.

#### TDD test suite (≥7 tests)

- **`factory.test.ts`** — `hypothesis<AppState>('name', body)` returns a `Hypothesis<AppState>` value with `name`, `body`, and `run` properties. The returned object is frozen; `Object.isFrozen(h)` is `true`. The `body` reference is the same object passed in (no defensive copy at construction, because the body is already typed as `readonly`).
- **`factory.test.ts`** — `hypothesis('', {...})` — empty name — does not throw at construction. The empty name is a smell, not a bug; the SARIF emitter logs `name: '<unnamed>'` and the test asserts the formatter substitutes the placeholder. We considered throwing on empty names; rejected because it complicates programmatic hypothesis generation (a test fixture builder might legitimately produce unnamed hypotheses).
- **`factory.test.ts`** — `hypothesis('dup', body)` called twice with the same name in the same module produces two distinct `Hypothesis` values. The factory does not enforce name uniqueness; that is the responsibility of `causl-check enumerate` which collects hypotheses across files and warns on duplicates.
- **`run.test.ts`** — invariant short-circuits the predicate. Construct a hypothesis where `invariant` returns `false` at step 3 and `predicate` would return `pass` over the whole trace. Assert `run(trace)` returns `{ kind: 'fail'; step: 3; witness: trace.steps[3].state; reason: 'invariant-violation' }` and that `predicate` was never called (use a spy via `vi.fn().mockImplementation(...)` and assert `spy.mock.calls.length === 0`).
- **`run.test.ts`** — invariant absent (undefined): `run` skips the per-step check and goes straight to the predicate. Construct a hypothesis with `invariant: undefined`, a passing predicate, and a 50-step trace; assert `run` returns `{ kind: 'pass' }` and the spy on a side-channel observable confirms no per-step iteration happened in the invariant phase.
- **`run.test.ts`** — invariant returns `true` at every step: `run` proceeds to the predicate. The invariant spy is called exactly `trace.steps.length` times; the predicate spy is called exactly once.
- **`run.test.ts`** — invariant fails at step 0: the verdict's `step` is 0, the witness is `trace.steps[0].state`, the reason is `invariant-violation`. The spec is explicit about `invariant-violation` being the reason for any invariant failure regardless of which step.
- **`run.test.ts`** — setup runs once per trace. Construct a setup function with a counter side-effect (test harness only; we document that adopters must not do this); call `run` against three different traces; assert the counter is at 3, not 3×N where N is trace length. This pins the contract that setup is per-trace, not per-step.
- **`run.test.ts`** — setup determinism check: call `run` twice against the same trace; assert the two verdicts are deeply equal. If setup is non-deterministic in `engine` alone (e.g., reads `Date.now()`), the two verdicts diverge and the test fails. This is the runtime gate against non-deterministic setup.
- **`run.test.ts`** — `name` is included in every emitted error message. Construct a hypothesis with `name: 'no-dispose-during-commit'`, induce a fail verdict, format it with `formatVerdict(h, v)`, assert the formatted string contains `'no-dispose-during-commit'` exactly once and the witness state's `lastCommit` field is rendered in the formatted output.
- **`run.test.ts`** — empty trace: `run(trace)` where `trace.steps.length === 0` returns `{ kind: 'fail'; step: 0; witness: <sentinel>; reason: 'empty-trace' }`. The sentinel witness is constructed by the runner and pinned in the test.
- **Property test (`run-property.test.ts`)** — for random `(setup, invariant, predicate)` triples drawn from a generator, the verdict is `pass` iff `invariant` holds at every step AND `predicate(trace).kind === 'pass'`. 1000 trials. The test re-implements the oracle in pure JS (a 30-line reference implementation) and asserts the runner agrees on every trial. The `fast-check` arbitrary for predicates is built from a small grammar (always/eventually/and/or of random `StepPredicate<unknown>` leaves) so the trials cover the combinator surface uniformly.
- **Property test (`run-property.test.ts`)** — for every fail verdict the runner emits, the verdict's `step` indexes a real position in `trace.steps`, the verdict's `witness` is reference-equal to `trace.steps[step].state`, and the verdict's `reason` is non-empty. 1000 trials.

The runner's core loop, sketched:

```ts
export function run<S>(h: Hypothesis<S>, trace: Trace<S>): Verdict<S> {
  if (trace.steps.length === 0) {
    return { kind: 'fail', step: 0, witness: SENTINEL_STATE, reason: 'empty-trace' }
  }
  if (h.body.invariant !== undefined) {
    for (const step of trace.steps) {
      if (!h.body.invariant(step.state)) {
        return { kind: 'fail', step: step.index, witness: step.state, reason: 'invariant-violation' }
      }
    }
  }
  return h.body.predicate(trace)
}
```

Twenty lines including types. The runner's correctness gate is the property test that re-implements this in 30 lines of pure JS and asserts the two implementations agree on 1000 random inputs.

#### 5 concerns

1. **Invariant short-circuits the predicate.** A passing predicate cannot mask a violated invariant. The runner returns at the first invariant failure, with `reason: 'invariant-violation'`, before the predicate is ever called. The spy test above is the gate. This matters because adopters will write predicates that test "the system reached steady state" and forget to check that the system never violated `acyclic()` along the way; the invariant catches the violation regardless of what the predicate says.
2. **Invariant failure produces verdict with `reason: 'invariant-violation'`.** Uniform reason string across all hypotheses. The SARIF emitter groups by this reason; if a future invariant wants a richer reason, it returns `false` and the predicate fires next, with whatever reason its combinator emits. We considered allowing the invariant to return a string (the failure reason); rejected because it complicates the type signature for negligible gain — the witness state already carries everything the adopter needs.
3. **Setup runs once per trace.** Side effects in setup do not bleed across traces because the engine is fresh per trace. The runner does not cache setup output across `run` calls — adopters who want caching write it themselves. We document this in the doc comment on `SetupFn<S>` and in the README's determinism section. The runtime determinism check above is the gate.
4. **`name` is included in every emitted error message.** Telemetry, SARIF output, and the CLI formatter all group by `name`. An adopter scanning a CI log for `'no-dispose-during-commit'` finds every failure of that hypothesis across the corpus. The name is also the join key for the differential test (TASK 4.5) when comparing Apalache and Rust verdicts on the same property.
5. **Property test for the runner.** For random `(setup, invariant, predicate)` triples, the verdict is `pass` iff invariant holds at every step AND `predicate(trace).kind === 'pass'`. The test draws from `fast-check` arbitraries; 1000 trials; failure dumps the seed for reproduction. The reference oracle is a 30-line pure-JS function; the implementation is a 60-line file under test. Divergence between the two is a runner bug or a spec ambiguity, both of which we want surfaced loudly.

### TASK 4.3 — Combinators: `always`, `eventually`, `holds(p).until(q)`, `afterCommit`, `during`, `never`, `implies`, `and`, `or`

**Files:** `packages/hypothesis/src/combinators/always.ts`, `eventually.ts`, `until.ts`, `after-commit.ts`, `during.ts`, `never.ts`, `implies.ts`, `and-or.ts`, plus a barrel `packages/hypothesis/src/combinators/index.ts`. Tests under `packages/hypothesis/test/combinators/` mirroring the source layout.

One combinator per file. The semantics are pinned in §16.5.1; this task is a faithful port. Each combinator is between 10 and 30 lines of TypeScript; the reason-string format is uniform (`<combinator>: <what failed> at step <index>`); the iteration shape is shared via a `forEachStep` helper that handles the empty-trace edge case once.

#### TDD test suite (≥15 tests across combinators)

- **`always.test.ts`** — trace where `p` holds at every step (10 steps, predicate returns true on each) → `{ kind: 'pass' }`. Assert no `step`/`witness`/`reason` fields on the verdict (pure-pass shape).
- **`always.test.ts`** — trace where `p` fails at step 5 → `{ kind: 'fail'; step: 5; witness: trace.steps[5].state; reason: 'always: predicate failed at step 5' }`. Assert the verdict's `reason` matches the regex `/^always: predicate failed at step \d+$/`.
- **`always.test.ts`** — first-failure semantics: trace where `p` fails at steps 5, 8, and 12 → verdict reports step 5, not step 12. The shrinker's earliest-step pass converges only because of this rule. The test pins the rule explicitly because a "naive" implementation that returns the last failure would still satisfy the spec's broader "fail iff p ever fails" but would break the shrinker.
- **`eventually.test.ts`** — trace where `p` holds at step 7 (and only step 7) → `{ kind: 'pass' }`. Trace where `p` never holds → `{ kind: 'fail'; step: <last>; witness: <last>.state; reason: 'eventually: predicate never held within trace bound' }`.
- **`eventually.test.ts`** — the earliest-success rule: `p` holds at steps 3, 7, 11 → `eventually` returns `pass` after observing step 3 and does NOT iterate past step 3. Spy on `p`; assert `spy.mock.calls.length === 4` (steps 0, 1, 2, 3).
- **`until.test.ts`** — `holds(p).until(q)`: trace where `p` holds at steps 0..3 and `q` first holds at step 4 → `{ kind: 'pass' }`. Verify `q` is checked before `p` at every step (the spec orders the check this way to handle the case where `q` and `p` fail simultaneously). Spy on both; at step 4, `q` is called and returns true; `p` is never called at step 4.
- **`until.test.ts`** — `p` fails at step 3 before `q` is ever true → `{ kind: 'fail'; step: 3; witness: <step-3>.state; reason: 'until: p failed at step 3 before q held' }`.
- **`until.test.ts`** — `q` never reached and `p` held throughout the entire 20-step trace → `{ kind: 'fail'; step: 19; witness: <step-19>.state; reason: 'until: q never held within trace bound' }`.
- **`until.test.ts`** — both `p` and `q` false at step 5: `q` is checked first and returns false, then `p` is checked and returns false; verdict is `{ fail; step: 5; reason: /until: p failed at step 5/ }`. The `q-first` evaluation order pins the reason string to `until:`-prefixed, not `eventually:` or `always:`.
- **`after-commit.test.ts`** — `afterCommit({ touches: 'inputId' }, p)`: trace contains a commit at step 4 that touches `inputId`, fanout settles by step 7 (phase: `idle`), `p` is checked at step 7 and fails → `{ kind: 'fail'; step: 7; witness: <step-7>.state; reason: /afterCommit:.*step 4/ }`. The reason names the *commit* step (4), not the eval step (7), so the adopter can locate the commit in the trace.
- **`after-commit.test.ts`** — phase gating: `afterCommit` does NOT evaluate `p` at steps 5 and 6 (which are `commit-fanout` and `commit-finalize`). Spy on `p` to confirm it is called exactly once across the trace, at step 7.
- **`after-commit.test.ts`** — matcher OR semantics: `afterCommit({ touches: 'inputId', tag: 'user-driven' }, p)` matches commits that touch `inputId` OR carry the `user-driven` tag. Construct a trace with three commits: one touching `inputId` only, one tagged `user-driven` only, one matching neither. Spy on `p`; assert it is called twice (once per matched commit's idle successor) and not at all for the unmatched commit.
- **`after-commit.test.ts`** — `any: true` matcher: `afterCommit({ any: true }, p)` matches every commit. Construct a trace with five commits; assert `p` is called five times.
- **`after-commit.test.ts`** — passing `(state, app)` to the predicate: the predicate signature for `afterCommit` is `(state: State<S>, app: S) => boolean`, NOT `StepPredicate<S>`. The `app` parameter is `state.app` for ergonomics (so the predicate body reads `app.cellId` instead of `state.app.cellId`). Test: assert the predicate receives both arguments and that `app === state.app` reference-equality holds.
- **`during.test.ts`** — `during('commit-fanout', p)` only fires at fanout-phase steps. Construct a trace with phases `[idle, commit-prepare, commit-fanout, commit-fanout, commit-finalize, idle]`; spy on `p`; assert `p` is called exactly twice (steps 2 and 3). Verdict is `pass` iff both calls return true.
- **`during.test.ts`** — `during('msg-dispatch', p)` on a trace with no `msg-dispatch` phase → vacuous pass (no steps to evaluate). The reason... is absent because pass verdicts carry no reason. We document this as vacuous and the formatter logs the vacuity if a debug flag is set.
- **`never.test.ts`** — `never('onError')` on a trace where `onError` fires at step 12 → `{ kind: 'fail'; step: 12; witness: <step-12>.state; reason: /never: onError fired at step 12/ }`.
- **`never.test.ts`** — `never('onError')` on a trace where `onError` never fires → `{ kind: 'pass' }`.
- **`never.test.ts`** — `never('onError')` is exactly equivalent to `always(s => !s.justFired('onError'))`. Property test: 100 random traces; verdicts from both forms are deeply equal.
- **`implies.test.ts`** — `implies(p, q)` where `p` is true at every step and `q` is false at step 8 → fail at step 8. The reason string is `implies: p held but q did not at step 8` — the word "vacuous" does NOT appear because this is a real violation.
- **`implies.test.ts`** — vacuous truth: `implies(p, q)` where `p` is false at every step → `{ kind: 'pass' }`. The reason... is absent because pass verdicts carry no reason. We are honest about vacuity at the doc-comment level and at the formatter level (the formatter logs `implies: pass (vacuous: p never held)` if a debug flag is set), but the verdict shape stays uniform.
- **`implies.test.ts`** — mixed: `p` is true at step 3 and false elsewhere; `q` is true at step 3 and false elsewhere. Verdict is `pass` because `p ⇒ q` holds at every step (the only step where `p` is true, `q` is also true). Test pins the standard material-implication semantics.
- **`and-or.test.ts`** — `and(p1, p2)` short-circuits on first failure. Spy on `p2`; construct `p1` that fails; assert `p2` is never called. The verdict is the verdict from `p1`.
- **`and-or.test.ts`** — `and(p1, p2)` both pass: verdict is `{ kind: 'pass' }`. Both spies are called exactly once.
- **`and-or.test.ts`** — `and()` (zero args): vacuous pass, `{ kind: 'pass' }`. The `Array.prototype.every` semantics — vacuously true.
- **`and-or.test.ts`** — `or(p1, p2)` short-circuits on first pass. Construct `p1` that passes; spy on `p2`; assert `p2` is never called.
- **`and-or.test.ts`** — `or(p1, p2)` on full failure: both `p1` and `p2` fail at different steps (3 and 7); verdict reports step 3 (the smallest step across the disjuncts), with the reason from `p1` (the disjunct whose step is smallest).
- **`and-or.test.ts`** — `or()` (zero args): vacuous fail, `{ kind: 'fail'; step: 0; witness: <first-step>; reason: 'or: empty disjunction' }`. We pick this over `pass` because an empty `or` is a programmer error and we want it loud.
- **Property test (`combinators/algebra.test.ts`)** — given random predicate trees built from the nine combinators, the verdict from the combinator implementation is consistent with a manual evaluator (a pure-JS reference oracle in the test itself). 500 trials. The reference oracle is 50 lines of TypeScript; the implementation is the 200 lines under test. The test catches divergence between the spec-as-prose and the spec-as-code.
- **Property test (`combinators/algebra.test.ts`)** — De Morgan's laws don't apply directly (we have no `not`), but composition closure holds: `and(always(p), eventually(q))` is `Predicate<S>`; type-checks; tsc rejects mixing `Predicate<A>` and `Predicate<B>`.
- **Type-d test (`combinators/algebra.test-d.ts`)** — `// @ts-expect-error` on `and(always<MyApp>(...), always<OtherApp>(...))` confirms the cross-`S` mixing is a type error.

A representative combinator implementation, `eventually.ts` in full:

```ts
import type { Predicate, StepPredicate } from '../types.js'

export function eventually<S>(predicate: StepPredicate<S>): Predicate<S> {
  return (trace) => {
    for (const step of trace.steps) {
      if (predicate(step.state, step.index)) {
        return { kind: 'pass' }
      }
    }
    const last = trace.steps[trace.steps.length - 1]
    return {
      kind: 'fail',
      step: last.index,
      witness: last.state,
      reason: 'eventually: predicate never held within trace bound',
    }
  }
}
```

Sixteen lines including imports. The body matches §16.5.1 line-for-line. The `last` lookup is safe because the runner short-circuits on empty traces before any combinator runs; the contract is documented at both ends and the empty-trace test in TASK 4.2 is the gate. A future refactor that moves the empty-trace handling into the combinators directly would need to update this file and every other combinator file; we keep the handling centralized in the runner.

A representative `holds(p).until(q)`:

```ts
export interface UntilBuilder<S> {
  until(q: StepPredicate<S>): Predicate<S>
}

export function holds<S>(p: StepPredicate<S>): UntilBuilder<S> {
  return {
    until(q) {
      return (trace) => {
        for (const step of trace.steps) {
          if (q(step.state, step.index)) return { kind: 'pass' }
          if (!p(step.state, step.index)) {
            return {
              kind: 'fail',
              step: step.index,
              witness: step.state,
              reason: `until: p failed at step ${step.index} before q held`,
            }
          }
        }
        const last = trace.steps[trace.steps.length - 1]
        return {
          kind: 'fail',
          step: last.index,
          witness: last.state,
          reason: 'until: q never held within trace bound',
        }
      }
    },
  }
}
```

The `q-first` evaluation order is load-bearing and the test row above pins it.

#### 5 concerns

1. **First-failure semantics for `always`-shaped combinators.** `always(p)` returns the FIRST failing step, not the last; this lets the shrinker's earliest-step pass converge. The same rule holds for `during`, `afterCommit` (within the matched-commit subset), `implies`, `never`. `eventually` is the inverse — it returns the LAST step on failure, because failure means "never held" and the last step is the witness that the bound was reached without success.
2. **Vacuous truth for `implies` and zero-arg `and`/`or`.** `implies(p, q)` where `p` is false at every step is `pass`. Zero-arg `and()` is `pass` (vacuously true). Zero-arg `or()` is `fail` (loud, because empty disjunction is a programmer error). The reason string distinguishes "vacuous" from "real" at the formatter level, not at the verdict-shape level. An adopter who wants to forbid vacuous passes writes `and(eventually(p), implies(p, q))` — the `eventually(p)` clause forces `p` to hold somewhere, and the `implies` clause forbids the violation. We document this idiom in the README.
3. **Phase gating for `afterCommit` and `during`.** `afterCommit` only checks at `phase === 'idle'` after a matched commit; the spec calls this out as the load-bearing piece over a hand-rolled `always`. `during(phase, p)` only checks at the named phase. The phase-gating logic is centralized in a `forStepsMatching(predicate)` helper so the two combinators share the iteration shape and only differ in the matcher. Test: spy on `p` in both combinators and assert the call count matches the phase distribution in the fixture trace exactly.
4. **Composition closure.** `and(always(p), eventually(q))` is `Predicate<S>`; type-checks; tsc rejects mixing `Predicate<A>` and `Predicate<B>`. The `and<S>(...ps: ReadonlyArray<Predicate<S>>): Predicate<S>` signature pins `S` across all variadic args. The variadic generic inference threads `S` from the first arg through all subsequent args; the type-d test confirms this.
5. **Property test for the combinator algebra.** Given random predicate trees built from the nine combinators, the verdict from the combinator implementation is consistent with a manual evaluator (a pure-JS reference oracle in the test itself). 500 trials. The reference oracle is 50 lines of TypeScript; the implementation is the 200 lines under test. The test catches divergence between the spec-as-prose and the spec-as-code, which is the most common bug class for this kind of port.

### TASK 4.4 — Three-axis counterexample shrinker

**Files:** `packages/hypothesis/src/shrink.ts`, `packages/hypothesis/src/shrink/actions-pass.ts`, `nodes-pass.ts`, `step-pass.ts`, `packages/hypothesis/src/shrink/replay.ts`, `packages/hypothesis/test/shrink.test.ts`, `packages/hypothesis/test/shrink-property.test.ts`.

Per §16.5.2. Pass 1 (delta-debug actions), Pass 2 (drop/merge nodes), Pass 3 (truncate prefix). Outer loop runs to fixpoint. The shrinker invariant — every shrunk trace still violates the predicate — is enforced by re-running the hypothesis after every reduction; if a shrunk trace passes, we throw. The replay layer (`replay.ts`) is what re-runs the hypothesis against a candidate-shrunk action sequence; it shells out to the enumerator (EPIC-3) for the actual trace generation, because re-running setup and stepping the engine is the enumerator's job, not ours.

The delta-debug for Pass 1 is the standard Zeller algorithm: try removing chunks of size `n/2`, then `n/4`, down to size 1, accepting any chunk removal that preserves the failing verdict. The chunk-size halving is bounded by the action count, not by a fixed constant; on a 50-action trace the algorithm tries 25-action chunks first, then 12, then 6, then 3, then 1.

#### TDD test suite (≥8 tests)

- **`shrink.test.ts`** — Pass 1 (actions): a trace of 50 actions where actions [3, 17, 42] are load-bearing for the violation; the shrinker reduces to a trace whose action count is at most 5 (the three load-bearing plus up to two scaffolding actions the delta-debug couldn't drop). Assert `result.passes[0]` is `{ axis: 'actions'; before: 50; after: <=5 }`. The fixture is hand-constructed so the load-bearing actions are known; the test pins the upper bound, not the exact count, because delta-debug is not guaranteed to find the global minimum.
- **`shrink.test.ts`** — Pass 1 chunk progression: instrument the delta-debug with a counter that records the chunk size at each iteration; assert the sequence is monotonically non-increasing (25, 12, 6, 3, 1 on a 50-action trace) and the algorithm terminates when chunk size 1 fails to remove any action.
- **`shrink.test.ts`** — Pass 2 (nodes): a trace with 8 distinct nodes where only nodes A, B, C are involved in the violation; the shrinker reduces the node set to {A, B, C}. Assert `result.passes[1]` is `{ axis: 'nodes'; before: 8; after: 3 }`.
- **`shrink.test.ts`** — Pass 2 merge variant: two nodes X and Y where the violation depends on the existence of a node touching `inputId` but not on whether that node is X or Y; assert the shrinker merges X into Y (or vice versa) and the resulting trace's node set has one fewer entry.
- **`shrink.test.ts`** — Pass 3 (step): a trace where the violation fires at step 12 but the predicate would also fail at step 4 if the prefix [0..3] were dropped; the shrinker truncates the prefix and reports the violation at step 4 of the reduced trace (the new step number is 4, since the 8-step prefix has been removed). Assert `result.verdict.step === 4 && result.passes[2] is { axis: 'step'; before: 12; after: 4 }`.
- **`shrink.test.ts`** — Pass 3 monotonicity guard: a trace where prefix truncation would move the violation step from 12 to 15 (if the truncation removed the actions that originally caused the early violation); the shrinker rejects the truncation and `passes[2].after === 12`. The pass never INCREASES the step index.
- **`shrink.test.ts`** — fixpoint: a synthetic trace where Pass 3's truncation re-enables a Pass-1 reduction the first iteration missed; assert the outer loop runs at least 2 iterations and the final reduction has the actions count strictly less than after iteration 1. The trace is constructed so that the prefix's first action is "noise" the delta-debug couldn't drop because doing so would have re-ordered later actions and broken the violation; after the prefix truncation removes the noise's downstream dependencies, the delta-debug can drop the noise on the second outer iteration.
- **Property test (`shrink-property.test.ts`)** — fixpoint convergence: 1000 random failing traces of length 50; assert convergence within ≤20 outer iterations on every trace. If any trace exceeds 20 iterations, dump the seed and fail the test loudly. The property pins the iteration ceiling so a future regression that introduces non-convergence is loud.
- **Property test (`shrink-property.test.ts`)** — shrinker invariant: 500 random failing traces; for every trace, every intermediate shrunk trace produced by every pass still has `hypothesis.run(intermediate).kind === 'fail'`. The test instruments the passes with a hook that captures every intermediate; failure dumps the seed and the offending pass name. This is the explicit guard against silent shrinker bugs.
- **`shrink.test.ts`** — invariant violation throw: inject a faulty pass that returns a passing trace (test-only knob in the shrinker); assert `shrink()` throws `Error('shrinker invariant violated: <pass-name>')` with the offending pass name in the message. This is the fail-loud guard for shrinker bugs and the test confirms the throw fires the moment the invariant is breached.
- **Property test (`shrink-property.test.ts`)** — Pass-3 monotonicity: for 500 random failing traces, the violation step in the shrunk trace is strictly less than OR equal to the violation step in the original. Pass 3 never INCREASES the step index. (Strict less than on traces where Pass 3 made progress; equal on traces where Pass 3 made no progress.)
- **Property test (`shrink-property.test.ts`)** — full algorithm contract: random failing trace of length 50; assert shrunk trace is shorter (action count ↓), has fewer distinct nodes (node count ↓), and the violation is at an earlier step OR the same step (never later). 500 trials. The compound assertion is the spec contract for "Hypothesis-style shrinking, not just `quickcheck` first-fail" from §16.5.
- **`shrink.test.ts`** — row-7 acceptance: a 50-event reproducer for a row-7 dynamic-dep cleanup race shrinks to ≤5 events. This is the §16.6 milestone-4 acceptance criterion. The fixture is a hand-constructed row-7 violation trace; the test pins the post-shrink action count at most 5.

The shrinker's outer loop, sketched:

```ts
export function shrink<S>(input: ShrinkInput<S>): ShrinkResult<S> {
  let current = input.trace
  let verdict = input.verdict
  const passes: Array<{ axis: Axis; before: number; after: number }> = []
  let progress = true
  let iter = 0
  while (progress && iter < 20) {
    progress = false
    for (const pass of [actionsPass, nodesPass, stepPass]) {
      const result = pass({ hypothesis: input.hypothesis, trace: current, verdict, seed: input.seed })
      if (result.shrunk) {
        // verify shrinker invariant
        const replayedVerdict = input.hypothesis.run(result.trace)
        if (replayedVerdict.kind !== 'fail') {
          throw new Error(`shrinker invariant violated: ${pass.name}`)
        }
        passes.push({ axis: pass.axis, before: result.before, after: result.after })
        current = result.trace
        verdict = replayedVerdict
        progress = true
      }
    }
    iter += 1
  }
  return { trace: current, verdict, passes }
}
```

The `iter < 20` guard is the convergence ceiling pinned by the property test. Each pass returns `{ shrunk: boolean; trace; before; after }`; the outer loop checks the invariant on every successful shrink before accepting the new state.

#### 5 concerns

1. **Fixpoint guarantee.** Outer loop runs until no pass makes progress on any axis. Property test: 1000 random failing traces; assert convergence within ≤20 outer iterations. The 20-iteration ceiling is conservative; in practice traces converge in 3-5 iterations. The ceiling is the regression gate. If a future change pushes convergence to 21 iterations on some trace, the test fails and we investigate; the expected fix is either to adjust the ceiling (with a documented reason) or to fix the change that caused the regression.
2. **Shrinker invariant.** Every shrunk trace still violates the predicate. The `throw new Error('shrinker invariant violated: <pass-name>')` at the end of `shrink()` fires the moment a shrunk trace passes; the test injects a faulty pass to verify the throw fires. The throw is loud at the call site because a silent shrinker bug is the worst failure mode in the package — the adopter sees a "fixed" trace that does not actually reproduce the bug, gets confused, files a false-positive ticket against the enumerator, and the team chases a phantom for a week.
3. **Pass 2 (node-drop) preserves the violation under setup re-run.** Dropping a node means re-running setup with the reduced node set; the resulting trace must still violate. If setup is non-deterministic in the dropped node's identity (e.g., `setup` reads `node.id` and branches on it), the reduction may not preserve the violation; the shrinker detects this case by re-running and rolling back. Test: a fixture where `setup` branches on node count; assert the shrinker correctly rejects the drop and reports `passes[1].after === passes[1].before`.
4. **Pass 3 (prefix truncation) never INCREASES the step index of the violation.** Property test above. The monotonicity is the load-bearing reason the pass converges: every successful truncation strictly reduces the step index, so the pass terminates in at most `step` iterations.
5. **Property test for the full algorithm.** Random failing trace of length 50; assert shrunk trace is shorter (action count ↓), has fewer distinct nodes (node count ↓), and the violation is at an earlier step OR the same step (never later). 500 trials. The compound assertion is the spec contract for "Hypothesis-style shrinking, not just `quickcheck` first-fail" from §16.5.

### TASK 4.5 — Apalache differential-test scaffold

**Files:** `packages/hypothesis/src/apalache/runner.ts`, `mapping.ts`, `verdict-join.ts`, `isomorphism.ts`, `report.ts`, `packages/hypothesis/test/apalache-diff.test.ts`, `packages/hypothesis/test/fixtures/apalache/` (test-only mini-corpus of 2 models for the JS-side test; the real 10-model corpus lives in EPIC-7).

Per §16.5.1's closing section and §16.5.2. The 10-model corpus lives in EPIC-7 (`tools/enumerator/corpus/`); this EPIC owns the JS-side runner and the divergence-detection. The runner shells out to `apalache-mc check` (Apalache's CLI) and reads its JSON output, joins against the Rust enumerator's verdicts, and emits a divergence report when verdicts disagree. The runner is invoked from `.github/workflows/checker-diff.yml` (owned by EPIC-7) and produces `apalache-diff-report.md` as a workflow artifact; report generation is owned here.

The mapping (`mapping.ts`) parses `mapping.toml` from the corpus directory and provides a join-key dictionary `(apalache_id) → (rust_id)` for both action names and node identifiers. The isomorphism check (`isomorphism.ts`) walks two witness states and asserts they are identical up to the mapping; field-by-field equality on app payload, set equality on `justFired` after translation, and reference-equality on `lastCommit.intent`.

#### TDD test suite (≥7 tests)

- **`apalache-diff.test.ts`** — model parsing: `mapping.toml` has 10 entries (or 2 for the in-package mini-corpus), each pointing to a `.tla` file and a `.scenario.rs` file. Missing files fail the test loudly with the model name in the error message. Extra entries (a `.tla` with no mapping row) also fail with the offending file name. The test exercises both directions: missing-mapping-entry-for-existing-file and missing-file-for-existing-entry.
- **`apalache-diff.test.ts`** — verdict join (pass/pass): both engines return `pass` on a model → join row is `{ model; property; status: 'agree-pass' }`; no divergence emitted; the report does not include the row in its divergence section but does include it in a summary table.
- **`apalache-diff.test.ts`** — verdict join (fail/fail with isomorphic witnesses): both engines return `fail`; the witness states are isomorphic up to the `mapping.toml`'s identifier mapping; soft-pass with informational note. The note appears in `apalache-diff-report.md` but does not red-flag CI. The test stubs the report writer and asserts the note is emitted.
- **`apalache-diff.test.ts`** — verdict join (pass/fail): one engine returns `pass`, the other returns `fail`; the test fails CI with a divergence row naming the model, the property, and the disagreeing verdicts. Test exercises both directions (Apalache pass + Rust fail; Apalache fail + Rust pass).
- **`apalache-diff.test.ts`** — bound-exceeded handling: Rust returns `bound-exceeded`, Apalache returns `pass` → soft-failure, opens an issue (the test stubs the issue-opening hook and asserts it was called with the model name and property name), does not red-flag CI. The opposite direction (Apalache exceeds, Rust passes) is also soft-failure with the same handling.
- **`apalache-diff.test.ts`** — fail/fail with non-isomorphic witnesses: hard-failure, divergence row includes the witness diff. The test constructs a fixture where the witnesses share the same fail step but the `state.app` payloads differ in a way the mapping cannot reconcile (e.g., Apalache says `cellId === 4` while Rust says `cellId === 7` and the mapping does not reconcile 4 to 7). The diff is rendered as a side-by-side table in the report.
- **`apalache-diff.test.ts`** — Apalache CLI invocation: the runner invokes `apalache-mc check --inv=<property> <model.tla>` and parses the resulting `_apalache-out/<run>/Counterexample.tla` file. The test stubs the CLI with a fixture output and asserts the parser correctly extracts the verdict and witness.
- **`apalache-diff.test.ts`** — Apalache CLI failure mode: if `apalache-mc` exits with a non-zero status that is not a counterexample (e.g., parse error in the model), the runner emits a hard-failure with the CLI's stderr included. The test stubs a malformed model and asserts the failure surfaces.
- **`apalache-diff.test.ts`** — report generation: given a fixed set of join rows, `report.generate(rows)` produces `apalache-diff-report.md` matching a snapshot. Snapshot covers agree-pass, agree-fail-isomorphic, disagree-pass-fail, bound-exceeded soft-failure, and disagree-non-isomorphic cases. The snapshot is stored in `packages/hypothesis/test/fixtures/apalache/expected-report.md` and the test diffs the generated output against it.
- **Property test (`apalache-diff.test.ts`)** — random hand-written models (test-only generator that produces TLA+ and Rust scenario pairs from a known race-class template) with known race classes; assert the differential test detects no divergence. 50 trials; if divergence is ever detected, dump the model and fail the test. The generator covers row-1 / row-7 / row-8 templates because those are the §9.1 rows the model-checker layer is responsible for.

A representative `mapping.toml` entry:

```toml
[[model]]
name = "row-7-dynamic-dep-cleanup"
tla = "corpus/apalache/row-7.tla"
rust = "corpus/rust/row-7.scenario.rs"
properties = ["DerivedAlwaysFresh", "NoStaleSubscription"]

[model.identifiers]
# Apalache id -> Rust IR id
"InputCell" = "input_cell"
"DerivedCell" = "derived_cell"
"CommitAction" = "commit"
"DisposeAction" = "dispose"
```

The runner reads the file, validates the `properties` list against both engines' output, and joins on `(model.name, property)`. The `identifiers` table is consumed by `isomorphism.ts` to translate Apalache witness states into Rust-IR-comparable form before the deep-equal check. A missing identifier in the table that appears in either witness fails the test loudly with `unknown identifier '<id>' in model '<name>' — add to mapping.toml or remove from model`.

#### 5 concerns

1. **Model parsing.** TLA+ models are parsed via the `mapping.toml` join key; missing or extra entries fail the test loudly. The runner does not auto-discover models; the mapping is the source of truth and the test's first assertion is that every mapping row points to a real file pair on disk. We considered auto-discovery (glob `corpus/apalache/*.tla` and `corpus/rust/*.scenario.rs`); rejected because it breaks the explicit-mapping invariant — auto-discovery would silently include a partially-paired model and the divergence test would either crash or pass spuriously.
2. **Verdict joining.** `(model, property) → (apalache_verdict, rust_verdict)`. Disagreement on `pass`/`fail` fails CI. The join is a left-join on the mapping; missing-from-Apalache or missing-from-Rust is a hard error (the model didn't run, which is a runner bug, not a divergence). The test exercises both directions.
3. **Witness isomorphism.** Both verdicts `fail` but witnesses isomorphic-up-to-mapping → soft-pass with informational note. The isomorphism check uses the `mapping.toml` to translate Apalache identifiers to Rust IR identifiers and then compares the witness states field-by-field. A non-trivial isomorphism (e.g., reordered actions that are commutative under the spec) is out of scope; we accept "exact-up-to-mapping" only and document the limitation in the report header.
4. **Bound-exceeded on Rust + pass on Apalache.** Soft-failure, opens an issue, does not red-flag CI. The interpretation: the Rust enumerator's bound was too tight for a property Apalache can prove. The fix is either to raise the bound on that scenario in the corpus (cheap) or to accept that the property is out of reach for the bounded enumerator (expensive — moves the property to the documentation pile). The issue-opening hook is mocked in the test; in CI it points at the GitHub issues API via the `gh` CLI invoked from the workflow, not from this package.
5. **Property test.** Random hand-written models with known race classes; assert the differential test detects no divergence. The test-only generator produces models from a row-1 / row-7 / row-8 template (the three §9.1 rows the model-checker layer is responsible for); the differential runner must agree on every property. Failure dumps the model.

## Acceptance gate

**Status:** satisfied. The §16.5.1 acceptance coverage lives in `packages/hypothesis/test/spec-16-5-1-{factory,commit-matcher,during-phase,fixes}.test.ts` plus `combinators.test.ts`, `shrink-axis-2-3.test.ts`, `shrink-multi-axis.test.ts`, and `apalache.test.ts`. The single `spec-16.5-acceptance.test.ts` file this doc anticipates was split into per-concern test files during the Phase-8 audit follow-on ([#571](https://github.com/iasbuilt/causl/issues/571), [#588](https://github.com/iasbuilt/causl/issues/588)). The original gate prose follows for design context.

`packages/hypothesis/test/spec-16.5-acceptance.test.ts` — five hypothesis files exercising the five most-used combinators (`always`, `eventually`, `holds(p).until(q)`, `afterCommit`, `never`); assert each returns `pass` on a known-good trace and `fail` on a known-bad trace with the correct `step` and `witness`. The good/bad trace pairs are checked into `packages/hypothesis/test/fixtures/spec-16.5/`; each pair is a JSON file the enumerator (EPIC-3) emits on a known-good and known-bad scenario. The hypothesis files themselves live alongside in `packages/hypothesis/test/fixtures/spec-16.5/hypotheses/*.causl-hyp.ts` and exercise the adopter-facing API surface end to end.

The five hypothesis files:

1. `derived-never-stale-after-commit.causl-hyp.ts` — uses `afterCommit`; pass when the derived cell equals 2× input after a commit touching `inputId`, fail when fanout produces a stale read.
2. `acyclic-always.causl-hyp.ts` — uses `always` against `s.graph.acyclic()`; pass on race-free traces, fail on a row-8 cycle violation.
3. `dispose-eventually-after-unmount.causl-hyp.ts` — uses `eventually` against `s.justFired('dispose')` after a row-mount-then-unmount sequence; pass when the dispose fires within bound, fail on a row-11 leak.
4. `loading-until-resolved.causl-hyp.ts` — uses `holds(p).until(q)` against `s.app.resourceState === 'loading'` until `s.justFired('resolved')`; pass on race-free async, fail on a row-6 stale-async pattern.
5. `never-double-commit.causl-hyp.ts` — uses `never('commit-during-commit')`; pass on serialized commits, fail on a row-1 nested-commit violation.

A representative acceptance hypothesis, `derived-never-stale-after-commit.causl-hyp.ts`:

```ts
import { hypothesis, afterCommit } from '@causl/hypothesis'

interface AppState { cellId: NodeId; inputId: NodeId }

export default hypothesis<AppState>('derived-never-stale-after-commit', {
  bound: { maxNodes: 12, maxCommits: 6, maxAsyncDepth: 2, maxMsgFanout: 3 },
  setup: (engine) => {
    const inputId = engine.input(0)
    const cellId = engine.derived(({ get }) => get(inputId) * 2)
    return { cellId, inputId }
  },
  invariant: (s) => s.graph.acyclic(),
  predicate: afterCommit({ touches: 'inputId' }, (s, app) =>
    s.graph.read(app.cellId) === 2 * s.graph.read(app.inputId),
  ),
})
```

The acceptance test loads this file, loads two trace JSON files (`derived-never-stale-after-commit.good.json` and `derived-never-stale-after-commit.bad.json`), runs the hypothesis against each, and asserts:

```ts
const good = await loadTrace('derived-never-stale-after-commit.good.json')
const bad = await loadTrace('derived-never-stale-after-commit.bad.json')

expect(h.run(good)).toEqual({ kind: 'pass' })

const verdict = h.run(bad)
expect(verdict.kind).toBe('fail')
if (verdict.kind === 'fail') {
  expect(verdict.step).toBe(7) // post-commit-fanout idle step
  expect(verdict.witness.app.cellId).toBe('cellId')
  expect(verdict.reason).toMatch(/^afterCommit:.*step 4/)
}
```

Five hypotheses, ten trace files, five test cases per hypothesis = 50 assertions. The acceptance test is the §16.5 reopen-trigger gate. When this test goes green, §16.5's hypothesis API is shippable; when it goes red, §16.5 stays in PLANNED. The gate is reviewable: five hypotheses, ten traces, fifty assertions. An adopter or a reviewer can read the test in fifteen minutes and understand exactly what the package guarantees.

The full §16.6 milestone-3 acceptance criterion is broader — "a hand-written hypothesis fails closed when an injected race fires; passes when the script is race-free" — and that broader gate lives in EPIC-3 (the enumerator side) plus this EPIC's TASK 4.5 (the differential side). The five-hypothesis acceptance test is the in-package gate; the differential test is the cross-package gate; together they close §16.5.

## Package layout

```
packages/hypothesis/
├── package.json              # name: "@causl/hypothesis", private: false, sideEffects: false
├── tsconfig.json             # extends ../../tsconfig.base.json, strict: true
├── src/
│   ├── index.ts              # public barrel: hypothesis, always, eventually, holds, afterCommit, during, never, implies, and, or
│   ├── types.ts              # Trace, Step, State, Verdict, Predicate, StepPredicate, Bound, PhaseStep
│   ├── factory.ts            # hypothesis<S>(name, body) factory
│   ├── run.ts                # Hypothesis<S>.run(trace) implementation
│   ├── freeze.ts             # Object.freeze walker for deserialized traces
│   ├── serialize.ts          # JSON serializer/deserializer
│   ├── combinators/
│   │   ├── index.ts          # combinator barrel
│   │   ├── always.ts
│   │   ├── eventually.ts
│   │   ├── until.ts          # holds(p).until(q)
│   │   ├── after-commit.ts
│   │   ├── during.ts
│   │   ├── never.ts
│   │   ├── implies.ts
│   │   ├── and-or.ts
│   │   └── for-step-helper.ts # shared iteration helper
│   ├── shrink.ts              # outer loop
│   ├── shrink/
│   │   ├── actions-pass.ts    # delta-debug
│   │   ├── nodes-pass.ts      # drop/merge
│   │   ├── step-pass.ts       # prefix truncation
│   │   └── replay.ts          # re-run hypothesis against candidate
│   └── apalache/
│       ├── runner.ts
│       ├── mapping.ts
│       ├── verdict-join.ts
│       ├── isomorphism.ts
│       └── report.ts
├── test/
│   ├── types.test.ts
│   ├── types.test-d.ts
│   ├── serialize.test.ts
│   ├── factory.test.ts
│   ├── run.test.ts
│   ├── run-property.test.ts
│   ├── combinators/
│   │   ├── always.test.ts
│   │   ├── eventually.test.ts
│   │   ├── until.test.ts
│   │   ├── after-commit.test.ts
│   │   ├── during.test.ts
│   │   ├── never.test.ts
│   │   ├── implies.test.ts
│   │   ├── and-or.test.ts
│   │   ├── algebra.test.ts
│   │   └── algebra.test-d.ts
│   ├── shrink.test.ts
│   ├── shrink-property.test.ts
│   ├── apalache-diff.test.ts
│   ├── spec-16.5-acceptance.test.ts
│   └── fixtures/
│       ├── types/
│       ├── spec-16.5/
│       │   ├── hypotheses/   # five .causl-hyp.ts files
│       │   └── traces/       # ten .json files (good + bad per hypothesis)
│       └── apalache/         # 2-model in-package mini-corpus + expected report snapshot
├── REASONS.md                # reason-string format reference (non-normative)
└── WIRE.md                   # wire-format reference (pinned by EPIC-3)
```

The `package.json` `exports` map:

```json
{
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./internal": { "types": "./dist/internal.d.ts", "default": "./dist/internal.js" }
  }
}
```

The `internal` export is the unstable surface for the differential runner and the SARIF emitter; adopters never import from there. The two-export shape is the one Hejlsberg is on record about: every package exposes a stable surface and an internal surface, and the internal surface is documented as such so consumers do not accidentally take a dependency on it.

## Milestone ordering

**Status:** all five tasks merged 2026-05-03; the historical ordering is preserved below for context. The original calendar estimates were illustrative and do not reflect actual landed schedule.

The five tasks land in this order, with each task gated on the previous:

1. **TASK 4.1 (types)** — lands first, no dependencies. Two weeks. Acceptance: every test in §TASK-4.1 green; tsc strict mode produces zero errors; `dist/` contains both `.js` and `.d.ts` for the types module.
2. **TASK 4.2 (factory + run)** — depends on 4.1. One week. Acceptance: every test in §TASK-4.2 green; the runner short-circuits on invariant failure and the property test passes 1000 trials.
3. **TASK 4.3 (combinators)** — depends on 4.1 and 4.2. Three weeks (one combinator family per ~2 days, plus integration testing). Acceptance: every test in §TASK-4.3 green; the algebra property test passes 500 trials.
4. **TASK 4.4 (shrinker)** — depends on 4.2 and 4.3. Three weeks. Acceptance: every test in §TASK-4.4 green; the row-7 fixture shrinks to ≤5 events (§16.6 milestone-4 criterion); the fixpoint property test passes 1000 trials.
5. **TASK 4.5 (Apalache differential)** — depends on 4.2 (for the verdict shape) and 4.3 (for the predicate evaluation). Two weeks for the JS-side runner; the 10-model corpus is EPIC-7's deliverable and lands separately. Acceptance: every test in §TASK-4.5 green against the 2-model in-package mini-corpus; the report snapshot matches.

Total: ~11 weeks of focused work for one full-time engineer, or ~6 weeks for a pair. The acceptance gate (§spec-16.5-acceptance.test.ts) spans all five tasks and lands as the final sign-off.

The §16.6 milestone-3 criterion ("a hand-written hypothesis fails closed when an injected race fires; passes when the script is race-free") cannot be fully closed by this EPIC alone — it requires EPIC-3 (the enumerator) to inject the race and produce the trace. This EPIC's portion of the milestone is the "fails closed" + "passes on clean" assertions in the acceptance test, against trace fixtures hand-constructed to match what the enumerator will produce.

## Risk register

The risks called out in the brutal-critical review above, ranked by likelihood × impact and paired with mitigations:

**R1 — Shrinker invariant violation slips past the loud throw.** Likelihood: low (the throw fires immediately on any pass returning a passing trace); impact: high (a silent shrinker bug erodes adopter trust faster than any other failure mode in the package). Mitigation: the throw is unit-tested with an injected faulty pass (TASK 4.4 test row 7); the property test runs 500 random failing traces through every pass and asserts the verdict stays `fail` at every intermediate. We also add a fuzz hook that the differential test (TASK 4.5) exercises: shrunk traces flowing into Apalache must still produce the same verdict Apalache produced on the original; divergence here is an additional gate.

**R2 — Inference failure on `S` produces silent `unknown` widening.** Likelihood: medium (TypeScript inference is fragile around variadic generics and conditional types); impact: medium (the adopter loses autocomplete and gets `any`-typed `s.app`, which is annoying but not unsafe at runtime). Mitigation: every public combinator returns an explicitly-typed `Predicate<S>`, never `Predicate<infer S>`; the test-d suite covers the cross-`S` mixing case; the README's "common pitfalls" section calls out the autocomplete check.

**R3 — Apalache CLI version drift breaks the differential test.** Likelihood: medium (Apalache ships breaking changes between minor versions); impact: medium (the differential test goes red, and the team has to either pin Apalache or update the parser). Mitigation: the workflow YAML (EPIC-7) pins Apalache to a specific minor version; the parser handles the pinned version's output format and rejects unknown formats with a clear error. We do not auto-upgrade Apalache; the bump is an intentional PR.

**R4 — Adopters write non-deterministic setup and report flaky hypotheses.** Likelihood: high (adopters will reach for `Math.random()` or `Date.now()` instinctively); impact: low (the determinism check in TASK 4.2 catches it on first run). Mitigation: the runtime determinism check is the gate; the README's first paragraph on setup is a determinism-only callout; we offer a `clock?: () => number` injection hook in the `Engine` API (owned by EPIC-3) so adopters who legitimately need time can inject a deterministic source.

**R5 — Combinator algebra has a corner case the property test misses.** Likelihood: low (500 trials covering random predicate trees is broad); impact: high if it slips into adopter hypotheses (a passing hypothesis that should fail is the worst class of bug). Mitigation: the property test's reference oracle is reviewed in PR; the test seed-dump on failure makes any divergence reproducible; the Apalache differential test (TASK 4.5) is a second oracle that catches a subset of these bugs.

**R6 — Wire-format drift between Rust enumerator and JS deserializer.** Likelihood: medium (any schema-3 IR change has to land in both EPICs); impact: high (the deserializer crashes or, worse, silently misinterprets fields). Mitigation: the wire format carries a version number; the deserializer rejects unknown versions; the version constant is in a shared header file the version-lockstep workflow (EPIC-1) checks on every release.

**R7 — Performance regression on large traces.** Likelihood: medium (the bounded enumerator can produce traces up to `maxNodes × maxCommits × maxAsyncDepth` steps; some combinators are O(N) per step); impact: medium (CI runs slow; adopter experience degrades). Mitigation: every combinator is documented with its time complexity; the property test in TASK 4.3 includes a perf-regression check that asserts a 1000-step trace evaluates in <100ms on the CI runner; future regressions trigger the assertion.

**R8 — TypeScript strictness conflict with adopter projects.** Likelihood: low (we ship strict but consume normal); impact: low (adopters with non-strict configs see fewer type errors but still get the runtime behavior). Mitigation: the package's published `.d.ts` is generated under strict mode; adopters with non-strict configs can still consume the types but lose some of the inference guarantees. We document this in the README.

## §9.1 row coverage delivered by this EPIC

The hypothesis API is the substrate the PROPERTY and MODEL layers of §16A.1 are built on. The bounded enumerator (EPIC-3) is what walks the state space; this package is what evaluates the predicates against the walked space. The §9.1 rows the combination closes:

| #  | Race | Combinator pattern | Acceptance fixture |
| -- | ---- | ----- | -------- |
|  1 | Concurrent engine mutations | `never('commit-during-commit')` or `during('commit-prepare', s => !s.justFired('commit'))` | `never-double-commit.causl-hyp.ts` |
|  5 | Diamond glitches | `afterCommit({ any: true }, (s, app) => glitchFreedomInvariant(s, app))` | covered by `@causl/glitch-freedom` adopter property test, not in this EPIC's acceptance |
|  6 | Stale-async resolution | `holds(s => s.app.resourceState === 'loading').until(s => s.justFired('resolved'))` | `loading-until-resolved.causl-hyp.ts` |
|  7 | Dynamic-dep cleanup | `eventually(s => s.justFired('dispose'))` after a row-mount-then-unmount | `dispose-eventually-after-unmount.causl-hyp.ts` |
|  8 | Cycle in derivation graph | `always(s => s.graph.acyclic())` as invariant or predicate | `acyclic-always.causl-hyp.ts` |
| 11 | Use-after-dispose on family node | `never('use-after-dispose')` event sugar | covered by §16A.2's `UseAfterDispose` static pass + this EPIC's runtime fixture |

Rows 2, 3, 4, 12, 13, 14, 15, 16, 17 are STATIC-caught by §16A.2's passes and do not need a hypothesis-API treatment. Rows 9, 10 are RUNTIME-ONLY per §13.7 and are out of scope for the model-checker layer entirely.

The acceptance test in §spec-16.5-acceptance.test.ts covers rows 1, 6, 7, 8 directly. Row 5 (diamond glitches) is covered by the `@causl/glitch-freedom` adopter property test, which uses this package's `afterCommit` combinator but is not in this EPIC's acceptance fixture set. Row 11 (use-after-dispose) is covered by both the static pass (EPIC-2) and a runtime hypothesis fixture; the runtime fixture lands as part of the acceptance test.

## Open questions for the team review

Before we cut the first PR off this EPIC, we need answers from the team review. The following questions are raised explicitly so they get answered in the review and not after the implementation lands.

**Q1: Does `holds(p).until(q)` need a `weakUntil` variant in v1?** §16.5.1 names `weakUntil` as a future addition. Strong-`until` requires `q` to eventually hold; weak-`until` does not. The use case for weak-`until` is "p holds until q OR forever" — useful when the trace bound is the natural terminator. We default to strong-`until` because it is the stronger guarantee; an adopter who wants weak-`until` writes `or(holds(p).until(q), always(p))` until v1.x ships the dedicated combinator. Proposing: defer weak-`until` to v1.1.

**Q2: Should `setup` be allowed to return `Promise<S>`?** Today's signature is `SetupFn<S> = (engine: Engine) => S`. Synchronous. An adopter who wants async setup (e.g., reading a config file) cannot do so today. The enumerator (EPIC-3) does not do async work either, so the synchronous signature matches the enumeration model. Proposing: keep synchronous; if adopters need async, they use a top-level `await` in the hypothesis file before calling `hypothesis(...)`.

**Q3: Does the formatter belong in this package or in `causl-check`?** The reason strings are produced here; the formatting (CLI-friendly, SARIF-friendly) could live here or in `causl-check`. Today's plan: a minimal `formatVerdict(h, v): string` ships here for unit tests and adopter `console.log` debugging; the production CLI formatter and the SARIF emitter live in `causl-check`. The split keeps this package's surface small. Proposing: confirm the split.

**Q4: Should the differential runner's issue-opening hook be in this package or in CI?** The bound-exceeded soft-failure path opens a GitHub issue when Apalache and Rust disagree on a property where Rust is bound-limited. Today's plan: the hook is a callback the workflow injects; the package itself has no `gh` CLI dependency. Proposing: confirm the hook injection pattern and where the workflow YAML lives (EPIC-7 owns the workflow; this EPIC owns the hook signature).

**Q5: What is the right module-resolution shape for the public types?** The `Trace<S>` etc. are consumed by adopters (in their hypothesis files) and by the differential runner (internally). We considered exposing them via a separate `@causl/types` package; rejected because it bloats the dependency graph for a tiny payload. Today's plan: `Trace` and friends are exported from `@causl/hypothesis`'s root export. Adopters import `import type { Trace } from '@causl/hypothesis'`. Proposing: confirm.

**Q6: Should we ship a `react-testing` adapter?** An adopter using `@causl/react` writes hypotheses against the React-side state machine. The adapter would package up React-specific helpers (`afterRender`, `duringSuspense`). Today's plan: adapters ship in their own packages (`@causl/hypothesis-react`); this package stays React-agnostic. Proposing: confirm the adapter pattern.

**Q7: How do we handle `BigInt` and other non-JSON-serializable values in `state.app`?** Adopters writing in TypeScript may put `bigint`, `Date`, `Map`, `Set` in their `S` payload; these do not round-trip through `JSON.stringify`. Today's plan: the wire format is JSON, and `S` is constrained to JSON-serializable shapes; adopters who need richer types build them out of strings or arrays. We document this in the README and the `SetupFn<S>` doc-comment. Proposing: confirm. Alternative: ship a custom serializer with `@causl/serialize` that handles the richer types; defers to v1.x.

**Q8: Should `hypothesis` accept a `tags?: string[]` field for filtering?** The CLI may want to run only the `tags: ['ci-fast']` subset of hypotheses; today there is no tag mechanism. Proposing: defer to v1.x; in v1.0 the file-system organization (`hypotheses/fast/`, `hypotheses/slow/`) is the filtering mechanism.

**Q9: What is the diagnostic output when a combinator throws (vs. returns fail)?** A `StepPredicate<S>` that throws (e.g., reads an undefined property) should be caught by the runner and reported as a fail with `reason: 'predicate threw: <message>'`. Today's plan: the runner wraps every predicate call in `try/catch` and reports the throw as a fail. Proposing: confirm the wrapping pattern; the test row in TASK 4.2 covers this case.

**Q10: How do we version the wire format?** The `Trace<S>` JSON wire format is owned by EPIC-3 (the enumerator) but pinned in §16.5.1. A future schema change (e.g., adding a new `PhaseStep` arm) requires lockstep updates across EPIC-3, EPIC-4, and EPIC-1. Today's plan: the wire format carries an explicit version field; this package's deserializer rejects unknown versions with a clear error. Proposing: confirm the version-bump procedure and where the version constant lives.

## Out of scope

- The bounded enumerator (EPIC-3). This package consumes `Trace<S>` from the enumerator; it does not produce traces.
- The Apalache TLA+ corpus itself (EPIC-7) — only the JS runner here. The 10-model `tools/enumerator/corpus/` directory is EPIC-7's deliverable. This EPIC's TASK 4.5 ships the JS runner and a 2-model test-only mini-corpus for the runner's self-test.
- The `--passes` CLI in `causl-check` (EPIC-2). The CLI invokes this package as a library; the CLI itself is out of scope.
- The SARIF emitter for adopter-facing CI output. The reason strings this package emits are SARIF-compatible (uniform shape, grep-able), but the SARIF JSON serialization lives in `tools/checker/src/sarif.rs` (EPIC-2).
- The schema-3 IR wire format (EPIC-1). This package consumes the format; the format is owned by EPIC-1.
- The `holds(p).weakUntil(q)` variant. §16.5.1 names it as a future addition; this EPIC ships strong-`until` only. A weak-until ticket gets filed against the next minor release.
- The `not(p)` combinator. We considered shipping `not(p): Predicate<S>` for completeness; rejected because it complicates the verdict shape (a passing `not` is the absence of a failure, but the inner predicate's witness is still meaningful for diagnostics) and the use cases adopters have raised so far are all expressible via `implies(p, false)` or by negating the leaf `StepPredicate<S>` directly. We will revisit if adopters ask.
- Streaming traces. Today's `Trace<S>` is a finite array delivered all-at-once from the enumerator; we do not support streaming traces from a long-running enumeration. If the enumerator ever streams, this package will need a `runStreaming` variant; out of scope for this EPIC.
- Multi-trace hypotheses. A hypothesis runs against one trace; an adopter who wants to assert a property across multiple traces (e.g., "no two traces produce the same final state") writes a test outside this package's surface. Out of scope.
- TLA+ generation from hypothesis files. Apalache stays as a tiny-corpus oracle; we do not auto-translate adopter hypotheses to TLA+. §16.5 is explicit that this translation is rejected as a shipping path.
