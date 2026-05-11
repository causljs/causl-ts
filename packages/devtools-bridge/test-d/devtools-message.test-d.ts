/**
 * Compile-time fixture for `DispatchEvent` — pins the §17.4 / #379
 * narrowing contract against silent widening.
 *
 * Why this is a compile-time test, not a runtime test:
 *   The §17.4 commitment is that every discriminated union is a tagged
 *   union with an exhaustiveness check the type system can enforce.
 *   The previous `DevtoolsMessage` shape leaked an optional
 *   `state?: string` to the union root and an optional
 *   `status?: boolean` that overloaded toggle vs. set as
 *   presence/absence — both anti-patterns that runtime tests cannot
 *   catch (the type system silently permits the wrong shape; it just
 *   forces a runtime cast at the consumer to recover).
 *
 *   The post-decode `DispatchEvent` is the §17.4-shaped narrowing:
 *
 *     - `JUMP_TO_STATE` / `JUMP_TO_ACTION` carry a required
 *       `state: string`. Construction without `state` is a compile
 *       error — the runtime cast inside `applyJumpHandler` no longer
 *       needs to defend against the wire-shape's `state?:` optional.
 *
 *     - `PAUSE_RECORDING` and `LOCK_CHANGES` are split into
 *       `_TOGGLE` (no `status`) and `_SET` (required `status: boolean`)
 *       variants. The toggle-vs-set operation lives in the
 *       discriminator, not in the absence of a field.
 *
 *     - `IMPORT_STATE` carries a non-empty `times: ReadonlyArray<number>`.
 *       The protocol-seam decode is the single place that asserts
 *       non-emptiness; the handler's body is a one-liner over a typed
 *       payload.
 *
 * tsd is what stops a future PR from re-hoisting `state?:` to the
 * union root, or from collapsing `_TOGGLE` / `_SET` back into a single
 * variant with `status?: boolean`.
 */

import { expectAssignable, expectError } from 'tsd'
import type { DispatchEvent, MonitorMessageKind } from '../dist/index.js'

// ---- positive: well-formed variants typecheck ------------------------------

expectAssignable<DispatchEvent>({ kind: 'JUMP_TO_STATE', state: 'snap' })
expectAssignable<DispatchEvent>({ kind: 'JUMP_TO_ACTION', state: 'snap' })
expectAssignable<DispatchEvent>({ kind: 'PAUSE_RECORDING_TOGGLE' })
expectAssignable<DispatchEvent>({ kind: 'PAUSE_RECORDING_SET', status: true })
expectAssignable<DispatchEvent>({ kind: 'PAUSE_RECORDING_SET', status: false })
expectAssignable<DispatchEvent>({ kind: 'LOCK_CHANGES_TOGGLE' })
expectAssignable<DispatchEvent>({ kind: 'LOCK_CHANGES_SET', status: true })
expectAssignable<DispatchEvent>({ kind: 'IMPORT_STATE', times: [1, 2, 3] })
expectAssignable<DispatchEvent>({ kind: 'COMMIT' })
expectAssignable<DispatchEvent>({ kind: 'ROLLBACK' })
expectAssignable<DispatchEvent>({ kind: 'SWEEP' })
expectAssignable<DispatchEvent>({ kind: 'TOGGLE_ACTION', id: 7 })
expectAssignable<DispatchEvent>({ kind: 'TOGGLE_PERSIST' })

// ---- negative: JUMP variants demand `state: string` ------------------------
//
// The whole point of #379 is that JUMP_TO_STATE / JUMP_TO_ACTION /
// IMPORT_STATE no longer treat `state` as an optional that the
// handler has to runtime-check. Constructing a JUMP without `state`
// must fail to typecheck, otherwise `applyJumpHandler` would still
// need its `(msg as { state?: unknown }).state` cast.

expectError<DispatchEvent>({ kind: 'JUMP_TO_STATE' })
expectError<DispatchEvent>({ kind: 'JUMP_TO_ACTION' })
// `state` must be a string — `undefined` doesn't narrow it.
expectError<DispatchEvent>({ kind: 'JUMP_TO_STATE', state: undefined })

// ---- negative: PAUSE_RECORDING / LOCK_CHANGES toggle-vs-set is split -------
//
// The previous shape allowed `{ kind: 'PAUSE_RECORDING' }` to mean
// either "toggle" or "set", with the difference encoded as the
// presence/absence of `status?: boolean`. The new shape forces the
// caller to pick the variant — no `kind: 'PAUSE_RECORDING'` exists,
// no `status?` optional exists on either variant.

// `PAUSE_RECORDING` is no longer a kind — only `_TOGGLE` / `_SET`.
expectError<DispatchEvent>({ kind: 'PAUSE_RECORDING' })
expectError<DispatchEvent>({ kind: 'LOCK_CHANGES' })

// `_TOGGLE` carries no `status` field — a stray `status` is rejected
// because the variant has no place for it.
expectError<DispatchEvent>({ kind: 'PAUSE_RECORDING_TOGGLE', status: true })
expectError<DispatchEvent>({ kind: 'LOCK_CHANGES_TOGGLE', status: false })

// `_SET` requires a boolean `status` — omitting it or supplying a
// non-boolean fails to typecheck.
expectError<DispatchEvent>({ kind: 'PAUSE_RECORDING_SET' })
expectError<DispatchEvent>({ kind: 'LOCK_CHANGES_SET' })
expectError<DispatchEvent>({ kind: 'PAUSE_RECORDING_SET', status: 'on' })

// ---- negative: IMPORT_STATE carries a non-empty times array ----------------
//
// The runtime-narrowing in `decodeDispatch` is what enforces
// non-emptiness; the type-level contract is that `times` is required
// and is a number array. A missing `times` field fails to typecheck.

expectError<DispatchEvent>({ kind: 'IMPORT_STATE' })
expectError<DispatchEvent>({ kind: 'IMPORT_STATE', times: 'not-an-array' })

// ---- negative: TOGGLE_ACTION requires a numeric `id` -----------------------

expectError<DispatchEvent>({ kind: 'TOGGLE_ACTION' })
expectError<DispatchEvent>({ kind: 'TOGGLE_ACTION', id: 'string' })

// ---- exhaustiveness: MonitorMessageKind covers every variant ---------------
//
// The handler-table mapped type relies on `MonitorMessageKind` being
// exactly the union of `DispatchEvent['kind']` values. Pinning the
// alias at the type level guarantees a future variant addition shows
// up here as a compile-time mismatch.

expectAssignable<MonitorMessageKind>('JUMP_TO_STATE' as const)
expectAssignable<MonitorMessageKind>('JUMP_TO_ACTION' as const)
expectAssignable<MonitorMessageKind>('PAUSE_RECORDING_TOGGLE' as const)
expectAssignable<MonitorMessageKind>('PAUSE_RECORDING_SET' as const)
expectAssignable<MonitorMessageKind>('LOCK_CHANGES_TOGGLE' as const)
expectAssignable<MonitorMessageKind>('LOCK_CHANGES_SET' as const)
expectAssignable<MonitorMessageKind>('IMPORT_STATE' as const)
expectAssignable<MonitorMessageKind>('COMMIT' as const)
expectAssignable<MonitorMessageKind>('ROLLBACK' as const)
expectAssignable<MonitorMessageKind>('SWEEP' as const)
expectAssignable<MonitorMessageKind>('TOGGLE_ACTION' as const)
expectAssignable<MonitorMessageKind>('TOGGLE_PERSIST' as const)

// A made-up kind is not assignable — guards against silent kind aliasing.
expectError<MonitorMessageKind>('NOT_A_REAL_KIND' as const)
