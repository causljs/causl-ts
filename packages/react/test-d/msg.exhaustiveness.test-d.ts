/**
 * Compile-time exhaustiveness fixture for the typed `Msg` helper
 * (closes #369). The runtime contract lives in `test/msg.test.ts`;
 * this file is the load-bearing gate proving the helper produces a
 * *closed* discriminated union — adding a tag without a `case` arm,
 * or adding a tag without a `createUpdate` handler, is a
 * type-check failure rather than a runtime throw.
 *
 * SPEC §9 commits the engine-wide discipline that every
 * discriminated union is enforced structurally at compile time. The
 * MVU surface (§8) is the application boundary where that
 * discipline matters most: messages are the front door, and "make
 * impossible states impossible" applies *here*.
 *
 * Mechanism (four independent locks; any one failing breaks tsc):
 *
 *   Lock 1 (AssertExact on kind set) — locks the closed set of
 *   tags produced by `defineMsgs`. Adding or removing a tag in the
 *   spec changes the union of `MsgOf<typeof builder>['kind']`; the
 *   equality probe fails, breaking `pnpm typecheck`.
 *
 *   Lock 2 (Payload narrowing) — confirms `MsgOf` projects the
 *   payload type into the matching variant. If the helper widened
 *   payloads to `unknown` or dropped them, the structural equality
 *   probe would fail.
 *
 *   Lock 3 (assertNever switch probe) — a switch over the union
 *   with all arms covered must satisfy a `never` parameter at the
 *   default arm. Adding a fourth tag without a matching `case`
 *   would leave a non-`never` value flowing into `assertNever`.
 *   Mirrors the actual call-site shape we want users to write.
 *
 *   Lock 4 (createUpdate handler exhaustiveness) — `createUpdate`'s
 *   `Handlers` mapped type requires a key for every `Msg['kind']`.
 *   Omitting a handler for a known tag is a compile error. The
 *   ts-expect-error directive *requires* tsc to flag the line; if
 *   the omission is silently accepted, the directive itself reports
 *   an unused-directive diagnostic and CI fails. Either failure
 *   mode breaks the build — that is the exhaustiveness gate.
 *
 * Naming: *.test-d.ts is the conventional suffix for type-only
 * tests. The file is included by tsconfig.json via test-d/**\/* so
 * `tsc --noEmit` (the existing CI step) is the gate. No new
 * dependency, no new runner, no new CI hook.
 */

import {
  createUpdate,
  defineMsgs,
  payload,
  type Msg,
  type MsgOf,
  type Update,
} from '../src/index.js'

// Fixture spec under test. Three tags, two payload variants, one
// no-payload variant — covers both arms of the `Msg<K, P>`
// conditional.
const counterMsg = defineMsgs({
  inc: null,
  dec: null,
  set: payload<{ value: number }>(),
})

type CounterMsg = MsgOf<typeof counterMsg>

// Bidirectional-extends equality. Plain extends is one-directional;
// the bidirectional form is the canonical "exact match" probe in
// TypeScript type-level testing.
type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

// Lock 1: closed kind set. If a fourth tag is added to the spec,
// `CounterMsg['kind']` widens; the equality below resolves to
// `false` and the annotation fails. If a tag is removed, the same
// probe fails the other direction.
type _ExactKindSet = AssertExact<CounterMsg['kind'], 'inc' | 'dec' | 'set'>
const _kindSet: _ExactKindSet = true
void _kindSet

// Lock 2: payload narrowing. The `set` variant must carry
// `value: number` after extraction; any payload widening (e.g. to
// `unknown` or `Record<string, unknown>`) would fail the probe.
type _SetVariant = Extract<CounterMsg, { kind: 'set' }>
type _ExactSetShape = AssertExact<_SetVariant, { readonly kind: 'set'; value: number }>
const _setShape: _ExactSetShape = true
void _setShape

// The no-payload arm projects to `{ readonly kind: 'inc' }` only —
// no stray fields and no hidden phantom payload.
type _IncVariant = Extract<CounterMsg, { kind: 'inc' }>
type _ExactIncShape = AssertExact<_IncVariant, { readonly kind: 'inc' }>
const _incShape: _ExactIncShape = true
void _incShape

// `Msg<K, P>` template type: same projection as `defineMsgs`
// produces. Documenting the equivalence here so users who reach for
// the template form get the same shape as the builder.
type _ExactTemplate = AssertExact<Msg<'set', { value: number }>, _SetVariant>
const _template: _ExactTemplate = true
void _template

// Lock 3: assertNever exhaustiveness probe. A `switch (msg.kind)`
// covering all three arms must satisfy a `never` parameter at the
// default arm. Adding a fourth tag without a matching `case` would
// leave a non-`never` value flowing in and tsc would fail.
declare function _assertExhaustive(_value: never): never
function _exhaustivenessImpl(msg: CounterMsg): string {
  switch (msg.kind) {
    case 'inc':
      return 'inc'
    case 'dec':
      return 'dec'
    case 'set':
      return `set:${String(msg.value)}`
    default:
      return _assertExhaustive(msg)
  }
}
void _exhaustivenessImpl

// Lock 4: `createUpdate` handler exhaustiveness. The Handlers
// mapped type requires a key for every Msg['kind']. Omitting `set`
// must fail the type-check at the call site; the ts-expect-error
// directive turns the absence-of-error into a build failure too.
//
// Type-only fixture: never executed.
declare function _missingHandlerProbe(): Update<CounterMsg>
function _missingHandler(): Update<CounterMsg> {
  // @ts-expect-error -- omitting a handler for `set` must break the
  // call. If the mapped type ever stops requiring every tag, the
  // directive flips to "unused" and CI fails. Either failure mode
  // is the exhaustiveness gate.
  return createUpdate<CounterMsg>({
    inc: (_m, _g) => {},
    dec: (_m, _g) => {},
  })
}
void _missingHandler
void _missingHandlerProbe

// Variant constructors: the builder's `inc` is a zero-arg function;
// `set` requires a payload object. Calling them with the wrong
// arity must fail.
const _incCall: { readonly kind: 'inc' } = counterMsg.inc()
void _incCall
const _setCall: { readonly kind: 'set'; value: number } = counterMsg.set({ value: 7 })
void _setCall

// @ts-expect-error -- a no-payload variant rejects an argument; the
// constructor signature is `() => Msg<K>`.
counterMsg.inc({ stray: true })

// @ts-expect-error -- a payload variant rejects a missing argument;
// the constructor signature is `(payload: P) => Msg<K, P>`.
counterMsg.set()

// @ts-expect-error -- payload shape is enforced; a string where a
// number is expected breaks the call.
counterMsg.set({ value: 'not-a-number' })
