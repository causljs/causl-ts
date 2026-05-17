/**
 * @packageDocumentation
 *
 * SPEC §17.4 conformance for the {@link PersistenceError} discriminated
 * union (issue #370). The previous shape carried an optional
 * `cause?: unknown` on a single `migrate` arm, encoding two distinct
 * semantic states — *the caller supplied `migrate` and it threw* vs
 * *the caller never supplied a `migrate` at all* — as the presence /
 * absence of one optional field. That is the §17.4 anti-pattern of an
 * "X may or may not have Y" optional whose presence is a state machine
 * in disguise: a consumer's `switch (err.kind)` lands on `'migrate'`
 * and still has to runtime-check `err.cause !== undefined` to know
 * which mode actually fired, which is exactly what the
 * `@typescript-eslint/switch-exhaustiveness-check` rule cannot help
 * with — the discriminator stops at `kind`, the second axis lives in
 * optional-field land.
 *
 * Reshaping the union with two tags — `migrate-threw` (carries
 * `cause`) and `migrate-missing` (no payload) — makes the second axis
 * a real discriminator. With the split, a `switch (err.kind)` over
 * {@link PersistenceError} narrows to a body where `cause` is either
 * present-and-typed (`migrate-threw`) or structurally absent
 * (`migrate-missing`), and no body needs a presence check.
 *
 * This file is the "make impossible states impossible" gate: every
 * `@ts-expect-error` line below must surface a `tsc` error in the
 * shipped union — if it doesn't, the suppression itself becomes an
 * unused-suppression error and the suite fails to compile, which is
 * the failure mode we want.
 *
 * @see SPEC.md §17.4 — every discriminated union is a tagged union
 *   with an exhaustiveness check the type system can enforce.
 * @see docs/lifecycle.md §5.2 — the PersistedInput statechart, where
 *   `migrate-threw` and `migrate-missing` are now distinct edges out of
 *   the `Loading` / `Migrating` states (§17.7 — every kind is a
 *   reachable state).
 */

import { describe, expect, it } from 'vitest'
import { createCausl } from '@causljs/core'
import {
  memoryAdapter,
  persistedInput,
  type PersistenceError,
} from '../src/index.js'

/**
 * Compile-time probe set. Each branch constructs a literal of one
 * variant and the `@ts-expect-error` lines flag fields the
 * discriminator proves are absent (or required) on that tag.
 *
 * The functions are never called at runtime — `tsc` checks them; if
 * any `@ts-expect-error` becomes unnecessary the suppression itself
 * errors and the suite fails to compile.
 */
function _impossibleStateProbes(): void {
  // Legal: parse variant — key + cause.
  const _parse: PersistenceError = {
    kind: 'parse',
    key: 'k',
    cause: new Error('bad json'),
  }
  void _parse

  // Legal: migrate-threw — version pair + cause.
  const _migrateThrew: PersistenceError = {
    kind: 'migrate-threw',
    key: 'k',
    expectedVersion: 2,
    storedVersion: 1,
    cause: new Error('boom'),
  }
  void _migrateThrew

  // Illegal: migrate-threw missing `cause`. The whole point of the
  // tag split is that this branch always carries a cause; encoding
  // "no cause" is the job of `migrate-missing`, not an absent field
  // here.
  // @ts-expect-error — `cause` is required on the `migrate-threw` variant.
  const _migrateThrewMissingCause: PersistenceError = {
    kind: 'migrate-threw',
    key: 'k',
    expectedVersion: 2,
    storedVersion: 1,
  }
  void _migrateThrewMissingCause

  // Legal: migrate-missing — version pair, no cause.
  const _migrateMissing: PersistenceError = {
    kind: 'migrate-missing',
    key: 'k',
    expectedVersion: 2,
    storedVersion: 1,
  }
  void _migrateMissing

  // Illegal: migrate-missing carrying a `cause`. The discriminator
  // excludes `cause` from this variant entirely — there is no
  // exception to attach when the caller never supplied a migrator.
  const _migrateMissingWithCause: PersistenceError = {
    kind: 'migrate-missing',
    key: 'k',
    expectedVersion: 2,
    storedVersion: 1,
    // @ts-expect-error — `cause` is not a member of the `migrate-missing` variant.
    cause: new Error('there is no cause to attach'),
  }
  void _migrateMissingWithCause

  // Illegal: the old `'migrate'` tag is no longer assignable. A future
  // refactor that re-introduces the merged tag would silently retire
  // the §17.4 split; this probe tripwires it.
  const _legacyMigrate: PersistenceError = {
    // @ts-expect-error — `'migrate'` is no longer a member of the union; use `migrate-threw` or `migrate-missing`.
    kind: 'migrate',
    key: 'k',
    expectedVersion: 2,
    storedVersion: 1,
  }
  void _legacyMigrate

  // Legal: serialise / quota — payload-carrying primitives.
  const _serialise: PersistenceError = {
    kind: 'serialise',
    key: 'k',
    cause: new Error('bigint'),
  }
  void _serialise
  const _quota: PersistenceError = {
    kind: 'quota',
    key: 'k',
    cause: new Error('quota'),
  }
  void _quota
}
void _impossibleStateProbes

/**
 * Exhaustiveness probe — the core acceptance from #370. A `switch
 * (err.kind)` over {@link PersistenceError} must:
 *
 *   1. Cover every tag without a `default` arm.
 *   2. Read no optional `cause?` field inside any body — the second
 *      semantic axis (migrate-threw vs migrate-missing) is now the
 *      tag itself, not the presence of `cause`.
 *
 * The function below ends *without* a `default` arm and *without* an
 * `assertNever` fallback; TypeScript's narrowing has to prove every
 * case is handled or the function fails to compile because its return
 * type would include `undefined`. That is the contract the
 * `@typescript-eslint/switch-exhaustiveness-check` rule encodes; the
 * runtime assertion below pins it for a fresh `migrate-missing` and
 * `migrate-threw` instance produced by the live `loadInitial` path.
 */
function describePersistenceError(err: PersistenceError): string {
  switch (err.kind) {
    case 'parse':
      return `parse@${err.key}: ${String((err.cause as Error).message ?? err.cause)}`
    case 'migrate-threw':
      return `migrate-threw@${err.key}: ${err.storedVersion}→${err.expectedVersion}: ${String((err.cause as Error).message ?? err.cause)}`
    case 'migrate-missing':
      return `migrate-missing@${err.key}: ${err.storedVersion}→${err.expectedVersion}`
    case 'serialise':
      return `serialise@${err.key}: ${String((err.cause as Error).message ?? err.cause)}`
    case 'quota':
      return `quota@${err.key}: ${String((err.cause as Error).message ?? err.cause)}`
  }
}

describe('PersistenceError — SPEC §17.4 tagged-union conformance (#370)', () => {
  it('exhaustive switch over `kind` compiles without a default arm and dispatches both migrate variants', () => {
    // The mere fact that `describePersistenceError` compiled is the
    // type-level acceptance from #370. The runtime call exercises both
    // new tags through the public dispatch path so a future refactor
    // that drops a tag from the union but leaves the runtime branch
    // intact (or vice versa) trips one of the two assertions.

    // Drive the `migrate-missing` branch from `loadInitial`.
    const g1 = createCausl()
    const seen1: PersistenceError[] = []
    persistedInput(g1, 'a', 'fallback', {
      key: 'test:migrate-missing',
      storage: memoryAdapter({
        'test:migrate-missing': JSON.stringify({ version: 1, value: 'old' }),
      }),
      version: 2,
      onError: (err) => seen1.push(err),
    })
    expect(seen1.length).toBe(1)
    const missing = seen1[0]!
    expect(missing.kind).toBe('migrate-missing')
    // Structural absence of `cause` — not `cause: undefined`.
    expect('cause' in missing).toBe(false)
    expect(describePersistenceError(missing)).toBe(
      'migrate-missing@test:migrate-missing: 1→2',
    )

    // Drive the `migrate-threw` branch from `loadInitial`. Explicit
    // `<string>` pin: with a `throw`-only `migrate`, TS infers the
    // function's return type as `never`, which would then collapse
    // `initial: T` to `never` and refuse the literal `'fallback'`.
    // The same pin is used by the existing `makeOpts<string>(...)`
    // helper in `persistedInput.test.ts`.
    const g2 = createCausl()
    const seen2: PersistenceError[] = []
    persistedInput<string>(g2, 'b', 'fallback', {
      key: 'test:migrate-threw',
      storage: memoryAdapter({
        'test:migrate-threw': JSON.stringify({ version: 1, value: 'x' }),
      }),
      version: 2,
      migrate: () => {
        throw new Error('boom')
      },
      onError: (err) => seen2.push(err),
    })
    expect(seen2.length).toBe(1)
    const threw = seen2[0]!
    expect(threw.kind).toBe('migrate-threw')
    expect(describePersistenceError(threw)).toBe(
      'migrate-threw@test:migrate-threw: 1→2: boom',
    )
  })

  it('legacy `onMigrationFailure` fires on both new arms with the documented payload shape', () => {
    // The deprecated callback is a separate axis from the new tags.
    // The `migrate-threw` arm passes `error: <thrown>`; the
    // `migrate-missing` arm omits `error` entirely, matching the
    // payload shape consumers were observing under the old union.

    // migrate-missing — no `migrate` supplied.
    let missingPayload: { error?: unknown } | null = null
    const g1 = createCausl()
    persistedInput(g1, 'a', 'fallback', {
      key: 'legacy:missing',
      storage: memoryAdapter({
        'legacy:missing': JSON.stringify({ version: 1, value: 'old' }),
      }),
      version: 2,
      onError: () => {},
      onMigrationFailure: (info) => {
        missingPayload = info
      },
    })
    expect(missingPayload).not.toBeNull()
    expect('error' in missingPayload!).toBe(false)

    // migrate-threw — `migrate` supplied and threw. Same `<string>`
    // pin as above: a throw-only migrator's `never` return would
    // otherwise collapse the `initial` parameter.
    let threwPayload: { error?: unknown } | null = null
    const g2 = createCausl()
    persistedInput<string>(g2, 'b', 'fallback', {
      key: 'legacy:threw',
      storage: memoryAdapter({
        'legacy:threw': JSON.stringify({ version: 1, value: 'x' }),
      }),
      version: 2,
      migrate: () => {
        throw new Error('boom')
      },
      onError: () => {},
      onMigrationFailure: (info) => {
        threwPayload = info
      },
    })
    expect(threwPayload).not.toBeNull()
    expect((threwPayload! as { error: Error }).error.message).toBe('boom')
  })
})
