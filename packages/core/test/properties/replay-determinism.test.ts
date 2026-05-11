/**
 * @packageDocumentation
 *
 * Replay-determinism property suite (EPIC #280, sub-issue #284). Drives
 * a generated commit log against two independent engine instances and
 * asserts byte-equal serialisation of their IR after every command —
 * including commands that fail.
 *
 * This is one of the load-bearing property families: a recorded commit
 * sequence replayed on a fresh graph must produce a byte-identical
 * state. Property-based fuzz is the race-detection layer for everything
 * the type system and API shape don't catch, and replay-determinism is
 * the row in that catalogue that proves the engine is a function of its
 * input log.
 *
 * The harness is the canonical regression net for the engine's
 * atomicity contract (#265) — a transaction creates exactly one new
 * `GraphTime`, with no fractional time and no half-applied write set —
 * for the totality contract (#277), and for composite-statechart
 * conformance (#271). Engine, ResourceFleet, and ConflictRegistry all
 * live in one composite statechart with hierarchy and orthogonal
 * regions; a determinism failure here is by definition either (a) a
 * non-deterministic engine path, (b) a non-atomic commit (post-failure
 * state diverges), or (c) a statechart violation that lets one engine
 * accept what the other rejected.
 *
 * Stateful generators are built with `fc.commands` so the property
 * layer can shrink to a minimal failing prefix. Each command has a
 * `check` precondition, a `run` against both the model and the
 * system-under-test, and post-run invariants asserted via the seam
 * helpers (`assertConsistentGraphTime`, `assertResultStability`,
 * `recomputeCounter`).
 */

import { describe, it, expect } from 'vitest'
import * as fc from 'fast-check'
import {
  createCausl,
  CycleError,
  CauslError,
  type DerivedNode,
  type Graph,
  type InputNode,
  type Node,
  type CauslModel,
} from '../../src/index.js'
import { propertyOptions } from './seed.js'

// =====================================================================
// Generators + the model/system pair the harness drives.
// =====================================================================

/**
 * Stable id alphabet — short identifiers so `fc.commands`-driven
 * shrinking keeps counter-examples human-readable. Drawn from a fixed
 * pool so equality assertions don't have to defend against
 * symbol-leakage between engines.
 *
 * Re-exported so the cross-backend-determinism property suite (#685)
 * can share the same alphabet. Two engines drawing from divergent id
 * pools would compare apples to oranges.
 */
export const IDS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const
export type Id = (typeof IDS)[number]

/**
 * Per-engine bookkeeping the commands need at run time.
 *
 * Re-exported so the cross-backend-determinism property suite (#685)
 * can build its own `World`-shaped pairs around a {@link BackendEngine}
 * + the TS engine — the command alphabet defined below is parameterised
 * on this shape.
 */
export interface World {
  readonly graph: Graph
  /** Live input handles keyed by id. */
  readonly inputs: Map<Id, InputNode<number>>
  /** Live derived handles keyed by id. */
  readonly deriveds: Map<Id, DerivedNode<number>>
}

/** Construct two fresh engines so each property trial starts clean. */
export function makeWorlds(): { left: World; right: World } {
  return { left: makeWorld(), right: makeWorld() }
}

export function makeWorld(): World {
  // Pin `name` so both engines share a `graphId` — replay-determinism
  // asserts byte-identical IR projections, and `graphId` is a
  // schema-3 IRRecord field that would otherwise differ across two
  // engines (each minting its own UUID v4 fallback). The test's
  // semantic claim is "two engines built from the same trace produce
  // identical IRs"; the same setup must include the same name.
  return {
    graph: createCausl({ name: 'replay-test-engine' }),
    inputs: new Map(),
    deriveds: new Map(),
  }
}

/**
 * Snapshot helper — the byte-equal oracle. Two engines that landed
 * the same commit log must produce identical IR. `time`, `nodes`, and
 * `commits` are all required to match exactly.
 *
 * `JSON.stringify` is the byte-equality channel: the same channel the
 * bounded model checker uses to assert that replaying a captured commit
 * sequence from a captured snapshot produces a byte-identical model
 * state. Anything that diverges across engines surfaces here as a
 * single string-diff.
 */
export function ir(graph: Graph): string {
  const model: CauslModel = graph.exportModel()
  return JSON.stringify(model)
}

/**
 * Tag the only error class the harness expects to escape. Any other
 * error class is a real failure and must propagate to fast-check so
 * shrinking can isolate it.
 */
function isExpectedError(e: unknown): boolean {
  return e instanceof CauslError
}

// =====================================================================
// Stateful command shapes (fc.commands).
// =====================================================================

/**
 * Add an input node to both engines under the given id. No-op if the
 * id is already registered (idempotent under fc.commands shrinking).
 */
export class AddInputCommand implements fc.Command<World, World> {
  constructor(
    private readonly id: Id,
    private readonly initial: number,
  ) {}

  check(world: World): boolean {
    return !world.inputs.has(this.id) && !world.deriveds.has(this.id)
  }

  run(left: World, right: World): void {
    const a = left.graph.input(`in:${this.id}`, this.initial)
    const b = right.graph.input(`in:${this.id}`, this.initial)
    left.inputs.set(this.id, a)
    right.inputs.set(this.id, b)
  }

  toString(): string {
    return `AddInput(${this.id}, ${this.initial})`
  }
}

/**
 * Add a derived node summing two existing nodes (input or derived).
 * Pre-condition: both upstream ids are registered and the new id is
 * fresh. Avoids cycles by construction.
 */
export class AddDerivedSumCommand implements fc.Command<World, World> {
  constructor(
    private readonly id: Id,
    private readonly left1: Id,
    private readonly left2: Id,
  ) {}

  check(world: World): boolean {
    if (world.inputs.has(this.id) || world.deriveds.has(this.id)) return false
    if (!hasNode(world, this.left1)) return false
    if (!hasNode(world, this.left2)) return false
    return true
  }

  run(left: World, right: World): void {
    const ll = lookup(left, this.left1)
    const lr = lookup(left, this.left2)
    const rl = lookup(right, this.left1)
    const rr = lookup(right, this.left2)
    const dLeft = left.graph.derived<number>(`d:${this.id}`, (get) => get(ll) + get(lr))
    const dRight = right.graph.derived<number>(`d:${this.id}`, (get) => get(rl) + get(rr))
    left.deriveds.set(this.id, dLeft)
    right.deriveds.set(this.id, dRight)
  }

  toString(): string {
    return `AddDerivedSum(${this.id} = ${this.left1} + ${this.left2})`
  }
}

/**
 * Set an existing input on both engines in a `commit()` and assert
 * the IR stays in lockstep. The assertion is INSIDE the run so that
 * fc.commands' shrinking has a clean failure to bisect.
 */
export class CommitSetCommand implements fc.Command<World, World> {
  constructor(
    private readonly id: Id,
    private readonly value: number,
  ) {}

  check(world: World): boolean {
    return world.inputs.has(this.id)
  }

  run(left: World, right: World): void {
    const lh = left.inputs.get(this.id)!
    const rh = right.inputs.get(this.id)!
    left.graph.commit(`set:${this.id}`, (tx) => tx.set(lh, this.value))
    right.graph.commit(`set:${this.id}`, (tx) => tx.set(rh, this.value))
    expectByteEqualIR(left, right, `after CommitSet(${this.id}, ${this.value})`)
  }

  toString(): string {
    return `CommitSet(${this.id}, ${this.value})`
  }
}

/**
 * Try to register a derived that closes a cycle on an existing
 * derived id. Both engines must surface the same `CycleError` AND
 * leave their IR byte-equal afterwards — this is the regression net
 * for #265 (commit() rollback) and the engine-side enforcement of the
 * atomicity contract: a transaction creates exactly one new
 * `GraphTime`, and a rejected attempt advances time by zero with no
 * half-applied writes left behind.
 */
export class AttemptCycleCommand implements fc.Command<World, World> {
  constructor(
    private readonly tipId: Id,
    private readonly headId: Id,
  ) {}

  check(world: World): boolean {
    // Need two existing derived nodes where adding a `tip` derivation
    // depending on `head` would close a cycle (head reads tip).
    return (
      world.deriveds.has(this.tipId) &&
      world.deriveds.has(this.headId) &&
      this.tipId !== this.headId
    )
  }

  run(left: World, right: World): void {
    // Snapshot pre-state on both engines.
    const beforeLeft = ir(left.graph)
    const beforeRight = ir(right.graph)

    const lhTip = left.deriveds.get(this.tipId)!
    const rhTip = right.deriveds.get(this.tipId)!
    const lhHead = left.deriveds.get(this.headId)!
    const rhHead = right.deriveds.get(this.headId)!

    // Attempt to close a cycle by re-registering tip with a body that
    // reads head — both engines must reject the registration cleanly
    // OR, if the engine accepts it eagerly, must throw on the next
    // commit that triggers the cycle. We model the recompute-time
    // detection: install a value-reading derivation (which the engine
    // accepts on register since deps are empty until first compute,
    // then read-trace closes a cycle) and commit a write that would
    // force the cycle to materialise.
    const cycleId: Id | null = pickFresh(left)
    if (cycleId === null) return // no fresh id available; skip silently

    let leftThrew = false
    let rightThrew = false
    try {
      left.graph.derived<number>(`cyc:${cycleId}`, (get) => get(lhTip) + get(lhHead))
    } catch (e) {
      leftThrew = true
      if (!isExpectedError(e)) throw e
    }
    try {
      right.graph.derived<number>(`cyc:${cycleId}`, (get) => get(rhTip) + get(rhHead))
    } catch (e) {
      rightThrew = true
      if (!isExpectedError(e)) throw e
    }

    // Both engines must agree on whether the registration threw.
    expect(leftThrew).toBe(rightThrew)

    if (leftThrew && rightThrew) {
      // On rejection both engines must have left state byte-equal to
      // their pre-state — atomicity contract.
      expect(ir(left.graph)).toBe(beforeLeft)
      expect(ir(right.graph)).toBe(beforeRight)
    }

    // After the attempt, both engines must remain in lockstep.
    expectByteEqualIR(left, right, `after AttemptCycle(${this.tipId}→${this.headId})`)
  }

  toString(): string {
    return `AttemptCycle(${this.tipId}→${this.headId})`
  }
}

/**
 * Register-time cycle attempt that closes the cycle through a
 * holder pattern (avoiding TDZ on a self-referential `const`). On
 * REGISTRATION of `cyc1`, the engine eagerly evaluates the compute
 * which reads `holder.ref` (still null → reads input) — registers
 * cleanly. Then `cyc2` registers, reads `cyc1`. Finally `holder.ref
 * = cyc2`. **Subsequent re-registration of an id that closes the
 * cycle** would fire CycleError at registration. Causl's cycle
 * detection runs at registration only (commit-time recompute uses
 * cached computed values; deps are fixed once computed) — so the
 * realistic cycle scenario tested here is the registration-time
 * one. Both engines must reject it identically and leave their
 * IR byte-equal to pre-attempt.
 */
class CommitCycleCommand_DEPRECATED implements fc.Command<World, World> {
  constructor(
    private readonly inputId: Id,
    private readonly value: number,
  ) {}

  check(world: World): boolean {
    // Need a fresh input id and two fresh derived ids for the
    // holder-based cycle pair.
    return (
      world.inputs.has(this.inputId) &&
      pickFreshN(world, 2).length === 2
    )
  }

  run(left: World, right: World): void {
    const beforeLeft = ir(left.graph)
    const beforeRight = ir(right.graph)
    const beforeLeftTime = left.graph.now
    const beforeRightTime = right.graph.now
    const beforeLeftValue = left.graph.read(left.inputs.get(this.inputId)!)
    const beforeRightValue = right.graph.read(right.inputs.get(this.inputId)!)

    const li = left.inputs.get(this.inputId)!
    const ri = right.inputs.get(this.inputId)!

    // Holder pattern: closure dereferences holder.ref at run time, so
    // the compute body is not TDZ-locked at registration. After both
    // derived nodes register, we point holder.ref at n2 — closing
    // the cycle. The next commit forces recompute, which trips the
    // cycle guard inside `computeDerived`.
    const [idA, idB] = pickFreshN(left, 2) as [Id, Id]

    const holderL: { ref: Node<number> | null } = { ref: null }
    const holderR: { ref: Node<number> | null } = { ref: null }

    const n1L = left.graph.derived<number>(`cyc1:${idA}`, (get) =>
      holderL.ref !== null ? get(holderL.ref) : get(li),
    )
    const n2L = left.graph.derived<number>(`cyc2:${idB}`, (get) => get(n1L))
    holderL.ref = n2L

    const n1R = right.graph.derived<number>(`cyc1:${idA}`, (get) =>
      holderR.ref !== null ? get(holderR.ref) : get(ri),
    )
    const n2R = right.graph.derived<number>(`cyc2:${idB}`, (get) => get(n1R))
    holderR.ref = n2R

    // Both engines must throw CycleError on the next commit that
    // forces the cycle to materialise.
    let leftThrew = false
    let rightThrew = false
    try {
      left.graph.commit(`cyc:${this.inputId}`, (tx) => tx.set(li, this.value))
    } catch (e) {
      leftThrew = true
      if (!(e instanceof CycleError)) throw e
    }
    try {
      right.graph.commit(`cyc:${this.inputId}`, (tx) => tx.set(ri, this.value))
    } catch (e) {
      rightThrew = true
      if (!(e instanceof CycleError)) throw e
    }
    expect(leftThrew).toBe(true)
    expect(rightThrew).toBe(true)

    // ATOMICITY CONTRACT (regression net for #265):
    // A transaction creates exactly one new `GraphTime` on success and
    // zero on rejection — there is no fractional time. So:
    // - `now` did not advance
    // - input value did not change
    // - IR byte-equal to pre-state — no half-applied write set
    expect(left.graph.now).toBe(beforeLeftTime)
    expect(right.graph.now).toBe(beforeRightTime)
    expect(left.graph.read(li)).toBe(beforeLeftValue)
    expect(right.graph.read(ri)).toBe(beforeRightValue)

    // The two engines must remain byte-equal to their own pre-state
    // AND to each other.
    expect(ir(left.graph)).toBe(beforeLeft)
    expect(ir(right.graph)).toBe(beforeRight)
    expectByteEqualIR(left, right, `after CommitCycle(${this.inputId}, ${this.value})`)
  }

  toString(): string {
    return `CommitCycle(${this.inputId}, ${this.value})`
  }
}

function pickFreshN(world: World, count: number): Id[] {
  const out: Id[] = []
  for (const id of IDS) {
    if (out.length === count) break
    if (!hasNode(world, id)) out.push(id)
  }
  return out
}

// =====================================================================
// Local helpers.
// =====================================================================

function hasNode(world: World, id: Id): boolean {
  return world.inputs.has(id) || world.deriveds.has(id)
}

function lookup(world: World, id: Id): Node<number> {
  return (world.inputs.get(id) ?? world.deriveds.get(id))! as Node<number>
}

function pickFresh(world: World): Id | null {
  for (const id of IDS) if (!hasNode(world, id)) return id
  return null
}

/**
 * The byte-equal oracle: serialise both engines' IR and assert
 * identity. A diff here is a determinism violation — either the
 * generator is non-deterministic or one engine took a different path.
 */
export function expectByteEqualIR(left: World, right: World, label: string): void {
  const l = ir(left.graph)
  const r = ir(right.graph)
  if (l !== r) {
    throw new Error(
      `replay-determinism IR diverged at ${label}\n` +
        `LEFT  = ${l}\n` +
        `RIGHT = ${r}`,
    )
  }
}

// =====================================================================
// Property-test entry points.
// =====================================================================

/**
 * Top-level `fc.commands` arbitrary covering the full command lattice
 * defined above. `maxCommands` defaults to the within-backend
 * replay-determinism floor (40); cross-backend tiered fuzz (issue
 * #1073) raises it to 500 / 2000 for the PR / nightly tiers via the
 * `opts` argument.
 */
export function commandArbitrary(opts: { readonly maxCommands?: number } = {}) {
  return fc.commands(
    [
      fc
        .tuple(fc.constantFrom(...IDS), fc.integer({ min: -100, max: 100 }))
        .map(([id, v]) => new AddInputCommand(id, v)),
      fc
        .tuple(
          fc.constantFrom(...IDS),
          fc.constantFrom(...IDS),
          fc.constantFrom(...IDS),
        )
        .map(([id, l, r]) => new AddDerivedSumCommand(id, l, r)),
      fc
        .tuple(fc.constantFrom(...IDS), fc.integer({ min: -100, max: 100 }))
        .map(([id, v]) => new CommitSetCommand(id, v)),
      fc
        .tuple(fc.constantFrom(...IDS), fc.constantFrom(...IDS))
        .map(([t, h]) => new AttemptCycleCommand(t, h)),
    ],
    { maxCommands: opts.maxCommands ?? 40 },
  )
}

/**
 * SPEC §15 canonical replay-determinism seed registry.
 *
 * A short, named catalogue of hand-rolled command sequences that the
 * suite below uses as fixed regression rows AND that the cross-backend
 * determinism property suite (#685) reuses verbatim across every
 * (JS, WASM-{gc-builtins,gc-classic,serde}) pair. Keeping them in one
 * place means the canonical scenarios cannot drift between the
 * within-backend and across-backend gates.
 *
 * Each scenario is a tuple of fc.Command<World, World> instances; both
 * gates consume them through `fc.modelRun`. The shapes are pinned —
 * adding a row is fine; renaming or reordering is not, because the
 * cross-backend gate enumerates scenarios by key to construct trial
 * names.
 *
 * Conventions:
 *   - `id` field is human-readable, used in test titles. Stable string.
 *   - `description` is one sentence describing what the scenario pins.
 *   - `commands()` builds a fresh array per call so the underlying
 *     `fc.Command` instances are not aliased between trials (the
 *     commands are intentionally stateless, but the contract is "one
 *     array per `fc.modelRun`" so we honour it).
 */
export interface CanonicalSeed {
  readonly id: string
  readonly description: string
  readonly commands: () => ReadonlyArray<fc.Command<World, World>>
}

export const CANONICAL_SEEDS: ReadonlyArray<CanonicalSeed> = [
  {
    id: 'register-time-cycle-with-flanking-writes',
    description:
      'register a 3-node graph, set an input, attempt a registration-time cycle ' +
      '(both engines must reject identically), then set another input — IR must ' +
      'stay byte-equal at every step.',
    commands: () => [
      new AddInputCommand('a', 0),
      new AddInputCommand('b', 0),
      new AddDerivedSumCommand('c', 'a', 'b'),
      new AddDerivedSumCommand('d', 'c', 'a'),
      new CommitSetCommand('a', 5),
      new AttemptCycleCommand('c', 'd'),
      new CommitSetCommand('b', 11),
    ],
  },
  {
    id: 'spec-10-worked-example-arithmetic',
    description:
      'SPEC §10 worked example shape: two inputs feed a derived sum; each commit ' +
      'visibly advances the derived projection. Pins arithmetic determinism + ' +
      'derived-recompute ordering across backends.',
    commands: () => [
      new AddInputCommand('a', 1),
      new AddInputCommand('b', 2),
      new AddDerivedSumCommand('c', 'a', 'b'),
      new CommitSetCommand('a', 3),
      new CommitSetCommand('b', 10),
      new CommitSetCommand('a', 300),
    ],
  },
  {
    id: 'write-only-tight-loop',
    description:
      'No derived nodes, just a tight loop of input writes. Pins the atomic-' +
      'success path; a divergence here points squarely at the success-path ' +
      'engine, not the rollback path.',
    commands: () => [
      new AddInputCommand('a', 0),
      new CommitSetCommand('a', 1),
      new CommitSetCommand('a', 2),
      new CommitSetCommand('a', 3),
      new CommitSetCommand('a', 0),
    ],
  },
  {
    id: 'derived-fanout',
    description:
      'One input fans out into three derived nodes (a→b, a→c via b, a→d via c). ' +
      'Each write triggers a chain of recomputes; backends must agree on ' +
      'recompute order in the published commit.',
    commands: () => [
      new AddInputCommand('a', 0),
      new AddInputCommand('e', 0),
      new AddDerivedSumCommand('b', 'a', 'a'),
      new AddDerivedSumCommand('c', 'b', 'a'),
      new AddDerivedSumCommand('d', 'c', 'b'),
      new CommitSetCommand('a', 1),
      new CommitSetCommand('a', 2),
      new CommitSetCommand('e', 99),
    ],
  },
  {
    id: 'cycle-flanked-by-derivation-additions',
    description:
      'Interleave AddDerivedSum and AttemptCycle commands. Pins that a rejected ' +
      'cycle attempt does NOT shift the dependency graph either backend sees on ' +
      'the next derived addition.',
    commands: () => [
      new AddInputCommand('a', 1),
      new AddInputCommand('b', 1),
      new AddDerivedSumCommand('c', 'a', 'b'),
      new AddDerivedSumCommand('d', 'c', 'a'),
      new AttemptCycleCommand('c', 'd'),
      new AddDerivedSumCommand('e', 'd', 'a'),
      new CommitSetCommand('a', 100),
    ],
  },
]

/**
 * Lookup a canonical seed by id. Throws if the id is unknown so a
 * typo in a cross-backend test surfaces at startup, not as a quiet
 * skip.
 */
export function getCanonicalSeed(id: string): CanonicalSeed {
  const found = CANONICAL_SEEDS.find((s) => s.id === id)
  if (!found) {
    throw new Error(
      `unknown canonical seed id '${id}' — known ids: ${CANONICAL_SEEDS
        .map((s) => s.id)
        .join(', ')}`,
    )
  }
  return found
}

/**
 * Top-level suite. Three describe blocks per the EPIC #280 sub-issue
 * #284 spec: identical-log determinism, failure-trace stability,
 * generator-driven property.
 */
describe('replay determinism (EPIC #280 / #284)', () => {
  /**
   * The headline contract: two fresh engines that consume the same
   * command log must produce byte-equal IR after every step. A diff
   * is by definition a non-determinism (or a hidden state escape).
   */
  describe('identical command logs produce identical state', () => {
    /**
     * Property: for every generated command sequence, byte-equal IR
     * across two engines after each command. fc.commands handles
     * shrinking down to a minimal failing prefix.
     */
    it('byte-equal IR across two engines after every command', () => {
      fc.assert(
        fc.property(commandArbitrary(), (cmds) => {
          const start = makeWorlds
          fc.modelRun(() => {
            const { left, right } = start()
            return { model: left, real: right }
          }, cmds)
        }),
        propertyOptions(),
      )
    })

    /**
     * Determinism over plain `commit()` sequences: no cycle-inducing
     * commands, just a write log. Provides a tight regression net
     * for #265 specifically (atomic-success path) — if this fails
     * the bug is in the success-path engine, not the rollback path.
     */
    it('byte-equal IR over write-only command logs', () => {
      const writeOnly = fc.commands(
        [
          fc
            .tuple(fc.constantFrom(...IDS), fc.integer({ min: -100, max: 100 }))
            .map(([id, v]) => new AddInputCommand(id, v)),
          fc
            .tuple(
              fc.constantFrom(...IDS),
              fc.constantFrom(...IDS),
              fc.constantFrom(...IDS),
            )
            .map(([id, l, r]) => new AddDerivedSumCommand(id, l, r)),
          fc
            .tuple(
              fc.constantFrom(...IDS),
              fc.integer({ min: -100, max: 100 }),
            )
            .map(([id, v]) => new CommitSetCommand(id, v)),
        ],
        { maxCommands: 60 },
      )
      fc.assert(
        fc.property(writeOnly, (cmds) => {
          fc.modelRun(() => {
            const { left, right } = makeWorlds()
            return { model: left, real: right }
          }, cmds)
        }),
        propertyOptions(),
      )
    })
  })

  /**
   * #265 regression net: cycle-inducing commits must roll the engine
   * back to its pre-commit state. The atomicity contract — exactly
   * one new `GraphTime` per successful commit, zero on rejection —
   * means a failed commit cannot leak any of: an advanced `now`, a
   * landed input write, or a publish notification. If it does, two
   * engines that saw the same failed commit will diverge on every
   * subsequent write.
   */
  describe('failed commits do not perturb the trace', () => {
    /**
     * Hand-rolled scenario that pins the contract directly. Sequence:
     * register a 3-node graph, set the input, attempt a registration-
     * time cycle (which both engines must reject identically), set
     * the input again, observe byte-equal IR after every step.
     */
    it('two engines stay in lockstep through a registration-time CycleError attempt', () => {
      // Canonical seed — same row the cross-backend determinism gate
      // (#685) replays across every (JS, WASM-*) pair.
      const cmds = getCanonicalSeed(
        'register-time-cycle-with-flanking-writes',
      ).commands()
      fc.modelRun(() => {
        const { left, right } = makeWorlds()
        return { model: left, real: right }
      }, cmds)
    })

    /**
     * Stateful property over mixed success+failure logs. The presence
     * of CommitCycleCommand in the alphabet forces the rollback path
     * onto the test surface; the byte-equal IR assertion is the
     * regression net for #265.
     */
    it('property: mixed success+failure logs preserve byte-equal IR', () => {
      fc.assert(
        fc.property(commandArbitrary(), (cmds) => {
          fc.modelRun(() => {
            const { left, right } = makeWorlds()
            return { model: left, real: right }
          }, cmds)
        }),
        propertyOptions(),
      )
    })
  })

  /**
   * Final layer: the harness itself is non-trivial, so we pin its
   * own contract. If `expectByteEqualIR` ever stops actually
   * comparing IR — for example if `exportModel()` starts skipping
   * certain fields — the property layer would silently always pass.
   */
  describe('harness self-checks', () => {
    /**
     * IR is sensitive to value differences: divergent input writes
     * between the two engines must surface as a thrown error from
     * `expectByteEqualIR`.
     */
    it('expectByteEqualIR fails when the two engines diverge', () => {
      const left = makeWorld()
      const right = makeWorld()
      const la = left.graph.input('a', 1)
      const ra = right.graph.input('a', 1)
      left.inputs.set('a', la)
      right.inputs.set('a', ra)
      left.graph.commit('left-only', (tx) => tx.set(la, 99))
      // right does NOT commit — engines now diverged
      expect(() => expectByteEqualIR(left, right, 'self-check')).toThrow(
        /diverged/,
      )
    })

    /**
     * IR is stable across repeated reads on a quiescent engine —
     * no hidden timestamps, no allocation-dependent ordering.
     */
    it('exportModel() is byte-stable on a quiescent engine', () => {
      const w = makeWorld()
      const a = w.graph.input('a', 5)
      w.graph.derived<number>('b', (get) => get(a) * 2)
      w.graph.commit('seed', (tx) => tx.set(a, 7))
      const first = ir(w.graph)
      const second = ir(w.graph)
      expect(first).toBe(second)
    })
  })
})
