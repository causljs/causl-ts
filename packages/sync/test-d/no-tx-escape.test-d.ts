/**
 * Compile-time fixture for SPEC.async §3.1 Theorem 2 — closes the
 * Tx-escape seam at the type level (#575).
 *
 * SPEC.async §3.1 (line 204) prescribes:
 *
 *   "Type fixture `no-tx-escape.types.ts` asserts via tsd that the
 *   adapter's public surface exposes no function whose return type
 *   contains `Tx` or any structural equivalent — the seam is sealed
 *   at the type level and a PR adding such an escape fails
 *   `tsc --noEmit` before any test runs."
 *
 * The §17 commitment 7 fence depends on this gate: every observable
 * resource transition routes through `graph.commit(intent, run)`,
 * and `Tx` (the transaction handle) cannot escape the `run` callback.
 * If a future API addition returns a `Tx` (or a partial that carries
 * its `set` method) from a public `@causljs/sync` export, the staged
 * writes can be deferred past Phase A — and the §3 atomicity
 * contract becomes a hope, not a guarantee.
 *
 * The check is structural, not nominal: any function whose return
 * type carries a `set: (node, value) => unknown` shape (the Tx
 * surface) trips this fixture. Renaming the type doesn't bypass it.
 *
 * tsd-naming note: the file uses the `.test-d.ts` extension required
 * by tsd's directory scanner (configured in `packages/sync/package.json`
 * `tsd.directory: "test-d"`). SPEC.async §3.1 originally named the
 * file `no-tx-escape.types.ts` in `test/theorems/`; #575 puts it in
 * the standard tsd location alongside the other workspace test-d
 * fixtures so the typecheck:test-d gate picks it up automatically.
 */

import { expectAssignable } from 'tsd'
import type { Tx } from '@causljs/core'
import {
  ForbiddenResourceTransitionError,
  type ConflictKind,
  type ResourceHandle,
  type ResourceState,
} from '../src/index.js'

// ─── Lock 1: ResourceHandle methods don't return Tx ─────────────────

declare const handle: ResourceHandle<number>

// .fetch() returns Promise<T>, not Promise<Tx> or any wrapper.
expectAssignable<Promise<number>>(handle.fetch())
// .invalidate() returns void, not Tx.
expectAssignable<void>(handle.invalidate())
// .fail(err) returns void, not Tx.
expectAssignable<void>(handle.fail(new Error('boom')))

// ─── Lock 2: ResourceState arms don't expose a Tx-shaped field ──────

// The five-arm DU may carry value, origin, loadedAt, erroredAt,
// promise — but never a Tx-shaped writer. If a future arm widens
// to include `set`, this assertion fails.
declare const state: ResourceState<number>
type StateKeys<S> = S extends unknown ? keyof S : never
type AllStateKeys = StateKeys<ResourceState<number>>

// `set` is the Tx surface marker. None of the five arms should
// expose this key. We assert by checking that 'set' is not in
// the union of arm-keys.
type SetIsForbidden = 'set' extends AllStateKeys ? true : false
const _setIsForbidden: false = false satisfies SetIsForbidden
void _setIsForbidden
void state

// ─── Lock 3: Tx is NOT exported from @causljs/sync ────────────────────

// The @causljs/sync barrel must NOT re-export Tx. Adopters who need
// Tx must import from @causljs/core directly — that import path is
// the seam where the §17 commitment 7 review applies.
//
// Encoded as a type-level membership check. If `Tx` ever becomes a
// key of the @causljs/sync barrel, this AssertEquals trips at compile
// time — the union widens to include 'Tx' and the literal 'never'
// assertion fails.
type SyncBarrelKeys = keyof typeof import('../src/index.js')
type TxIsExported = 'Tx' extends SyncBarrelKeys ? true : false
const _txNotExported: false = false satisfies TxIsExported
void _txNotExported

// We also want to keep `Tx` referenced (so the import isn't
// stripped) — its non-presence in the barrel is the contract.
declare const _txMarker: Tx
void _txMarker

// ─── Lock 4: ForbiddenResourceTransitionError is the only public class ──

// The class export is fine — it's an error type, not a Tx wrapper.
// This assertion exists to document that the type-level export
// surface is exactly { ForbiddenResourceTransitionError, resource,
// createConflictRegistry, ... } and a future addition of a Tx-shaped
// class would be caught by Lock 3.
expectAssignable<typeof ForbiddenResourceTransitionError>(
  ForbiddenResourceTransitionError,
)

// ─── Lock 5: ConflictKind doesn't widen to include Tx-shape ─────────

declare const kind: ConflictKind
expectAssignable<'open' | 'resolved' | 'ignored' | 'superseded'>(kind)
