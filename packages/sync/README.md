# @causl/sync

> Async resources and conflict registry on top of
> [@causl/core](../core/). The package wires two of the orthogonal
> regions in Causl's composite lifecycle statechart — a per-resource
> ResourceFleet sub-statechart whose states are
> `Idle | Loading | Loaded | Stale | Errored`, and a per-conflict
> ConflictRegistry sub-statechart whose states are
> `Open | Resolved | Ignored | Superseded`. Conflicts are not a node
> kind; they are a derived view of the engine's own lifecycle.

## Install

```bash
pnpm add @causl/sync @causl/core
```

## Resource

```ts
import { createCausl } from '@causl/core'
import { resource } from '@causl/sync'

const graph = createCausl()
const items = resource<Item[]>(graph, 'items', {
  loader: async () => fetch('/api/items').then((r) => r.json()),
})

const result = await items.fetch()
const state = graph.read(items.node)
// state.state === 'idle' | 'loading' | 'loaded' | 'stale' | 'errored'
```

`ResourceState<T>` is a SPEC §9 discriminated union (`idle`, `loading`,
`loaded`, `stale`, `errored`) tagged on `state`. Reading `.value`
requires a tag check first, so the "reading a not-yet-loaded resource
value" race is caught by `tsc` rather than left to runtime — every
"X may or may not have Y" optional field is a state-machine-in-disguise
we surface as a tag.

### Staleness guard

The stale-async race — a fetch returns after its dependency changed —
is real and the engine cannot avoid it. What the engine can do is
guarantee a defined response: when another commit advances `GraphTime`
*between* `fetch()` start and loader resolve, the resource transitions
`Loading → Stale` rather than `Loading → Loaded`. The detection
compares the originating `GraphTime` of the fetch to the current
`GraphTime` at resolution; downstream consumers narrow on the tag
before reading `.value`.

Opt out per-resource for last-writer-wins:

```ts
resource(graph, 'items', { loader, stalenessGuard: false })
```

## Conflict registry

```ts
import { createConflictRegistry, singleConflictWhen } from '@causl/sync'

const conflicts = createConflictRegistry<Item[]>(graph, {
  id: 'conflicts',
  compute: singleConflictWhen(
    items.node,
    (s) => s.state === 'errored',
    () => ({ id: 'items-errored', target: items.key }),
  ),
})

conflicts.read(graph)
// [{ kind: 'open', id: 'items-errored', target: 'items', value, raisedAt }]

conflicts.resolve(graph, 'items-errored', { choice: 'use-cache' })
conflicts.read(graph)
// [{ kind: 'resolved', resolution: { choice: 'use-cache' }, resolvedAt, ... }]

conflicts.ignore(graph, 'items-errored')      // Open → Ignored
conflicts.supersede(graph, oldId, newId)      // Open → Superseded
```

### Narrowing on `kind`

`Conflict<T>` is the SPEC §9 discriminated union landed in #354 — the
discriminator is `kind`, never `status`. Each variant carries exactly
the fields the ConflictRegistry sub-statechart guarantees in that
state, so the `resolution`, `ignoredAt`, and `supersededBy` slots are
not optionals on a single shape but per-variant fields the type system
proves are reachable:

```ts
for (const c of conflicts.read(graph)) {
  switch (c.kind) {
    case 'open':
      ui.show(c.target, c.value)
      break
    case 'resolved':
      ui.audit(c.id, c.resolution, c.resolvedAt)
      break
    case 'ignored':
      ui.dim(c.id, c.ignoredAt)
      break
    case 'superseded':
      ui.link(c.id, c.supersededBy, c.supersededAt)
      break
  }
}
```

The shape mirrors `docs/lifecycle.md` §1's ConflictRegistry chart:
three legal transitions out of `Open` (`resolve`, `ignore`,
`supersede`); the other three states are terminal. A mutator targeting
a non-`open` conflict throws `ForbiddenConflictTransitionError` — no
silent no-op, because shipping enum tags whose transitions aren't in
the chart is the §17.7 anti-pattern this package was written against.

The `target` field on `ConflictBase<T>` is a `NodeId` identifying the
node the conflict relates to; the application's domain payload lives
on the per-conflict `value: T`.

The registry is not a node kind — it is a *derived view* over the
engine's own lifecycle. The runtime universe contains only Inputs and
Deriveds; "conflict" is a role, not a permanent kind. Resolutions are
stored as a single `Input<ReadonlyMap<...>>` updated by the registry's
mutator methods, and the public `Conflict[]` stream is a Derived that
overlays the resolution map onto an application-supplied open-set
compute.

## Property tests

Property-based tests are this package's race-detection layer. The
suite under `test/properties/` covers the SPEC.async §15.1 / §15.2
predicates as runtime shapes — the chart invariants the type system
can't ask about. Each property runs at the 1000-trial floor `SPEC.md`
§15.2 names, routed through the `tieredPropertyTrials` seam so the
nightly `MODEL_CHECK_TIER=2` bump to 10,000 trials is structural
(PR #1097 / #1073 shipped the tier-budget system; the conformance
meta-test rejects raw `{ numRuns: N }` literals so the floor can't
silently slip).

The currently-shipped properties:

| File | Property |
|---|---|
| `fetch-interleavings.test.ts` | Random `(commit \| fetch-start \| fetch-resolve \| fetch-reject)` programs end in a legal `ResourceState` tag with monotonic `origin` / `loadedAt` / `erroredAt`. |
| `race-row-S-1.property.test.ts` | SPEC.async §9.1.1 row S-1 — a post-invalidate fetch-resolve never lands as Loaded with the late value (stale-async resolution race). |
| `disposed-mid-load.property.test.ts` | Audit-doc S-2 row — disposed-mid-load (renamed from `race-row-S-2.*` in #919 to remove the false §9.1.1 S-2 claim; the SPEC.async §9.1.1 S-2 name belongs to `conflict-registry-drift.*`). |
| `conflict-registry-drift.property.test.ts` | SPEC.async §9.1.1 row S-2 — open-set drift mid-resolution; `resolve` commits at one GraphTime tick past the guard read regardless of mid-call source-map mutations. |
| `origin-bound-resolution.property.test.ts` | SPEC.async §15.1 / Property 2 — `Loading → Loaded` preserves the in-flight `origin`. |
| `single-writer-resolution.property.test.ts` | SPEC.async §15.2 / Property 7 — first mutator wins; subsequent `resolve`/`ignore`/`supersede` on a non-Open conflict are no-ops. |
| `lifecycle-exhaustiveness.property.test.ts` | SPEC.async §15.1 / Property 1 — every reachable post-state is one of the five chart arms. |
| `conflict-lifecycle-exhaustiveness.property.test.ts` | The conflict mirror — every reachable conflict-arm is one of `open`/`resolved`/`ignored`/`superseded`. |
| `forbidden-resource-transitions.property.test.ts` | Resource mutators on a non-source arm throw the typed error, never silently no-op. |
| `forbidden-conflict-transitions.property.test.ts` | Mutators targeting a non-`open` conflict throw `ForbiddenConflictTransitionError`. |
| `promise-identity-stability.property.test.ts` | SPEC.async §15.1 / Property 4 — repeated application of the same event sequence yields the same `(tag, value, origin)` tuple (the model-level analogue of the §3.1 Theorem 3 Promise-identity claim). |
| `open-set-computation.property.test.ts` | SPEC.async §15.2 / Property 8 — open-set membership equals the `open`-tagged conflicts after arbitrary event sequences. |
| `evaluate-statechart-agreement.property.test.ts` | The `JsBackend.evaluateStatechart` extension point in `@causl/core` and the canonical `reduceConflict` / `reduceResource` reducers in `@causl/sync/statechart-reducers` agree byte-equivalently on every `(state × event)` pair (the cross-implementation determinism gate landed by #1068). |

Failing inputs are shrunk and committed as regression cases; seeds
are deterministic so a CI failure is reproducible.

## Bundle budget (SPEC.async §14.2)

`@causl/sync` ships with per-primitive sub-imports so adopters who
only need the resource primitive (or only the conflict registry)
pay only for what they import. Three CI-gated `size-limit` ceilings
in the root `package.json`:

| Import | Ceiling |
|---|---|
| `@causl/sync` (full barrel) | 12 KB |
| `@causl/sync/resource` (resource-only) | 8 KB |
| `@causl/sync/conflict` (conflict-only) | 8 KB |

Resource-only consumers:

```ts
import { resource } from '@causl/sync/resource'
```

Conflict-only consumers:

```ts
import { createConflictRegistry } from '@causl/sync/conflict'
```

The full barrel `@causl/sync` re-exports both surfaces. A PR that
crosses one of the ceilings fails the `size — bundle-size gate` and
must include the §14.2 written team consensus or the size-limit bump
is rejected. The §14.2 narrative pins the trade-off: a smaller bundle
buys a smaller install footprint; the ceiling rules out unilateral
growth.
