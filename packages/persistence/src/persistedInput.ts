/**
 * persistedInput — register an Input on the engine whose value is
 * hydrated from a StorageAdapter on construction and written back to
 * the adapter on each commit that actually changes the value.
 *
 * Inputs only — `derived` is refused at the type level (the function
 * signature requires a non-derived initial value). A derived value at
 * time `t` is by definition `f(b₁(t), …, bₙ(t))`; persisting it would
 * mean storing a cache that goes stale the instant its formula or any
 * upstream input changes. Inputs are the only thing whose value isn't
 * a pure function of something else, so they're the only thing on-
 * disk-canonical state can legally describe.
 *
 * Schema evolution (#138): the on-disk envelope is `{ version, value }`.
 * Mismatched versions invoke `migrate(prev, prevVersion)`; if no
 * `migrate` is supplied, the stored envelope is preserved (default
 * `preserveOnError: true`) and the in-memory value falls back to
 * `initial`. Every error branch dispatches a typed
 * {@link PersistenceError} through `onError` — `migrate` is the only
 * legal upgrade path, and the absence of one raises a typed error
 * rather than silently overwriting on-disk data.
 *
 * Boot semantics (review-209 P0): the write path is wired to
 * `subscribeCommits` and filtered for commits that actually changed
 * this input's value, so a cold start never round-trips the same
 * envelope back to disk.
 */

import type {
  Commit,
  DerivedNode,
  Graph,
  InputNode,
  NodeId,
} from '@causl/core'
import type { StorageAdapter } from './storage.js'

/**
 * Capability handed to {@link persistedInput}. Applies the §13
 * leak-fence discipline at the persistence boundary: a storage
 * adapter crosses a trust boundary and gets only the authority its
 * job demands.
 *
 * `persistedInput` registers exactly one input, watches the commit
 * stream for changes, and reads the post-commit value to serialise.
 * Those three capabilities — `input` + `subscribeCommits` + `read` —
 * are the entire surface; `commit`, `derived`, `hydrate`, `snapshot`,
 * `exportModel`, `readAt`/`snapshotAt`, `commitLog`, and per-node
 * `subscribe` are intentionally unreachable.
 *
 * Narrowing is type-level rather than runtime-Proxy-level: the call
 * site already passes a real `Graph` (a full `Graph` is assignable to
 * this narrowed view), and the discipline is enforced at compile time
 * inside the implementation.
 */
export type PersistenceGraph = Pick<
  Graph,
  'input' | 'subscribeCommits' | 'read'
>

/**
 * Type-level guard that collapses to `never` when `T` is — or *contains
 * a member that is* — a {@link DerivedNode}, and to `unknown`
 * otherwise. Composed with `T &` at the `initial` parameter site, this
 * turns derived-typed inputs into `T & never = never` and forces a
 * compile error at the call site rather than allowing a derived value
 * to be silently wrapped.
 *
 * Why this exists (the §13 boundary):
 *   A derived value at time `t` is `f(b₁(t), …, bₙ(t))` — pure in its
 *   inputs at the same `GraphTime`. Persisting one means writing a
 *   cache that goes stale the instant any upstream input or formula
 *   changes; on rehydration the cache and the recomputed value would
 *   diverge, exactly the §3 glitch-freedom violation the engine was
 *   built to refuse. The README §13 boundary states this in prose;
 *   without this constraint and its tsd fixture, the prose has no
 *   compile-time backing and a future refactor can silently widen the
 *   parameter to accept `T | NodeRef<T>`.
 *
 * Distribution semantics:
 *   `T extends DerivedNode<unknown> ? true : never` distributes over
 *   unions, producing `true` for any member that is a derived node and
 *   `never` for any member that isn't. `[…] extends [never]` is then
 *   true only when *every* branch was `never`, i.e. when no member of
 *   `T` is a derived node. The strictness is intentional: a union
 *   containing a derived node is just as illegal as a bare derived,
 *   because the runtime path would still receive a `DerivedNode`
 *   handle through the parameter.
 *
 * @typeParam T - The value type the caller is wrapping. Must not be —
 *   and must not contain — a {@link DerivedNode}; primitives, plain
 *   JSON-serialisable values, and `InputNode<X>` (the latter a
 *   degenerate but legal shape) all collapse to `unknown` and pass
 *   through.
 */
export type AssertNotDerived<T> = [
  T extends DerivedNode<unknown> ? true : never,
] extends [never]
  ? unknown
  : never

/**
 * Discriminated union of failure modes surfaced by the persistence
 * layer. Every error branch in `loadInitial` and the write path
 * constructs one of these and dispatches it through
 * `PersistedInputOptions.onError`. The default handler is a single
 * `console.warn` so existing consumers remain audible during rollout.
 *
 * @remarks
 * Designed for `switch (err.kind)` exhaustiveness per the SPEC §17.4
 * commitment that every discriminated union is a *tagged* union with
 * an exhaustiveness check the type system can enforce. The
 * schema-evolution failure mode is split across two tags —
 * `migrate-threw` (the caller supplied `migrate` and it threw, carries
 * `cause`) and `migrate-missing` (the caller never supplied a
 * `migrate`, no `cause`) — because the previous shape encoded those two
 * distinct semantic states as the presence/absence of an optional
 * `cause?: unknown`, the §17.4 anti-pattern of an
 * "X may or may not have Y" optional that is a state machine in
 * disguise. With the split, `switch (err.kind)` narrows correctly and
 * no consumer body needs a runtime presence check on `cause` to know
 * which mode fired (#370).
 */
export type PersistenceError =
  | {
      readonly kind: 'parse'
      readonly key: string
      readonly cause: unknown
    }
  | {
      readonly kind: 'migrate-threw'
      readonly key: string
      readonly expectedVersion: number
      readonly storedVersion: number
      readonly cause: unknown
    }
  | {
      readonly kind: 'migrate-missing'
      readonly key: string
      readonly expectedVersion: number
      readonly storedVersion: number
    }
  | {
      readonly kind: 'serialise'
      readonly key: string
      readonly cause: unknown
    }
  | {
      readonly kind: 'quota'
      readonly key: string
      readonly cause: unknown
    }

/**
 * Caller-supplied error sink for {@link persistedInput}. Receives a
 * typed {@link PersistenceError}; never receives a raw `Error`.
 */
export type PersistenceErrorHandler = (err: PersistenceError) => void

/**
 * Configuration for {@link persistedInput}.
 *
 * @typeParam T - Value type stored under {@link PersistedInputOptions.key}.
 *
 * @remarks
 * The shape captures the four moving parts of write-through persistence
 * — *where* (`key` + `storage`), *what version* (`version` + `migrate`),
 * *what to do on failure* (`preserveOnError` + `onError`), and a
 * deprecated migration-only callback retained for adopter compatibility.
 * The defaults (`preserveOnError: true`, `onError: console.warn`) mirror
 * the issue #138 contract: persistence failures are observable but never
 * fatal, and the on-disk envelope is never silently discarded.
 */
export interface PersistedInputOptions<T> {
  /** Storage key under which the envelope is written. */
  readonly key: string
  /** Backing store. */
  readonly storage: StorageAdapter
  /** Schema version of `T`. */
  readonly version: number
  /**
   * Migrate an older-versioned stored value to current `T`. If absent
   * and the stored version differs, the in-memory value falls back to
   * `initial`; on-disk envelope is preserved when `preserveOnError`
   * is true (default).
   */
  readonly migrate?: (storedValue: unknown, storedVersion: number) => T
  /**
   * If `true` (default), parse / migrate / serialise / quota failures
   * leave the existing on-disk envelope untouched. Issue #138 mandates
   * this behaviour; flip to `false` only when callers explicitly want
   * the old "drop on failure" semantics.
   */
  readonly preserveOnError?: boolean
  /**
   * Callback invoked on every {@link PersistenceError}. Default is a
   * single `console.warn` per failure so behaviour remains audible
   * during the rollout window.
   */
  readonly onError?: PersistenceErrorHandler
  /**
   * Legacy migration-failure callback retained for backwards
   * compatibility. New code should use `onError` instead. When
   * supplied, it is invoked alongside `onError` for migrate-shaped
   * failures so existing consumers keep receiving notifications.
   *
   * @deprecated Prefer `onError(PersistenceError)`.
   */
  readonly onMigrationFailure?: (info: {
    key: string
    expectedVersion: number
    storedVersion: number
    error?: unknown
  }) => void
}

interface Envelope<T> {
  readonly version: number
  readonly value: T
}

const defaultOnError: PersistenceErrorHandler = (err) => {
  // The default sink is loud-but-non-fatal: a single `console.warn` per
  // failure so rollouts surface real problems without crashing the host.
  // Pass a no-op `onError` (or a structured logger) to silence.
  console.warn(`[causl/persistence] ${err.kind} failure`, err)
}

/**
 * Create an {@link InputNode} whose value is written through to a
 * {@link StorageAdapter} on every commit that changes it.
 *
 * @typeParam T - Stored value type. Cannot be a {@link DerivedNode}-like
 *   shape; the {@link AssertNotDerived} brand enforces this at compile
 *   time so a future refactor cannot silently widen the boundary.
 *
 * @param graph - Engine handle exposing the `input`, `read`, and
 *   `subscribeCommits` capabilities the adapter needs.
 * @param id - {@link NodeId} for the resulting input node.
 * @param initial - Fallback value used when storage is empty, the
 *   envelope fails to parse, or version migration is unavailable.
 * @param options - {@link PersistedInputOptions} bundle (`key`,
 *   `storage`, `version`, optional `migrate` / `preserveOnError` /
 *   `onError` / `onMigrationFailure`).
 * @returns A live {@link InputNode}`<T>` whose value mirrors the
 *   storage envelope. Writes go through `tx.set` exactly as for a
 *   regular `graph.input`.
 *
 * @remarks
 * The write hook is driven off `subscribeCommits` filtered by
 * `commit.changedNodes`, not `graph.subscribe`, so the initial value
 * is *not* round-tripped back to storage on cold start. On
 * serialise / migrate / quota failures the error is funnelled through
 * `options.onError` (default `console.warn`) and the on-disk envelope
 * is preserved when `preserveOnError` is true (default).
 */
export function persistedInput<T>(
  graph: PersistenceGraph,
  id: NodeId,
  // `T & AssertNotDerived<T>`: for non-derived `T`, this is `T & unknown
  // = T`; for `T = DerivedNode<X>` (or any union containing one), this
  // collapses to `never`, which makes the call site fail to typecheck.
  // The tsd fixture in `test-d/persistedInput.test-d.ts` pins this at
  // the type level so a future refactor cannot silently widen the
  // boundary. See {@link AssertNotDerived}.
  initial: T & AssertNotDerived<T>,
  options: PersistedInputOptions<T>,
): InputNode<T> {
  const onError = options.onError ?? defaultOnError
  const preserveOnError = options.preserveOnError ?? true
  const initialValue = loadInitial(initial, options, onError, preserveOnError)
  const node = graph.input<T>(id, initialValue)

  // Boot-write skip (review-209 P0): driving writes off `subscribeCommits`
  // with a `changedNodes`-id filter means we only hit storage when this
  // input's value actually changed. `graph.subscribe` would fire on the
  // initial value too and round-trip the same envelope back to disk on
  // every cold start.
  graph.subscribeCommits((commit: Commit) => {
    if (!commit.changedNodes.includes(id)) return
    const value = graph.read(node)
    let serialised: string
    try {
      const env: Envelope<T> = { version: options.version, value }
      serialised = JSON.stringify(env)
    } catch (err) {
      // Serialisation failure (cycles, BigInt, …): preserve existing
      // envelope when `preserveOnError`; never propagate to the engine.
      onError({ kind: 'serialise', key: options.key, cause: err })
      if (!preserveOnError) {
        try {
          options.storage.delete(options.key)
        } catch {
          // best-effort delete; quota reports already covered above
        }
      }
      return
    }
    try {
      options.storage.set(options.key, serialised)
    } catch (err) {
      // Quota / private-mode / disk-full: preserve existing envelope.
      onError({ kind: 'quota', key: options.key, cause: err })
    }
  })

  return node
}

function loadInitial<T>(
  initial: T,
  options: PersistedInputOptions<T>,
  onError: PersistenceErrorHandler,
  preserveOnError: boolean,
): T {
  const raw = options.storage.get(options.key)
  if (raw === null) return initial
  let parsed: Envelope<T>
  try {
    parsed = JSON.parse(raw) as Envelope<T>
  } catch (err) {
    // Corrupt / non-JSON envelope. `preserveOnError` keeps the bad
    // bytes on disk so a separate recovery tool can inspect them
    // rather than the library silently destroying user data.
    onError({ kind: 'parse', key: options.key, cause: err })
    if (!preserveOnError) {
      try {
        options.storage.delete(options.key)
      } catch {
        // ignore
      }
    }
    return initial
  }
  if (parsed.version === options.version) {
    return parsed.value
  }
  if (options.migrate) {
    try {
      return options.migrate(parsed.value, parsed.version)
    } catch (err) {
      // `migrate-threw` (#370): the caller supplied `migrate` and it
      // threw. Distinct tag from `migrate-missing` so a consumer's
      // `switch (err.kind)` narrows to the throws branch and reads
      // `cause` without a runtime presence check.
      const errEnv: PersistenceError = {
        kind: 'migrate-threw',
        key: options.key,
        expectedVersion: options.version,
        storedVersion: parsed.version,
        cause: err,
      }
      onError(errEnv)
      options.onMigrationFailure?.({
        key: options.key,
        expectedVersion: options.version,
        storedVersion: parsed.version,
        error: err,
      })
      if (!preserveOnError) {
        try {
          options.storage.delete(options.key)
        } catch {
          // ignore
        }
      }
      return initial
    }
  }
  // Stored version differs and no `migrate` supplied. Loud no-silent-
  // downgrade per #138: report through `onError` and (default) leave
  // the on-disk envelope alone so a future build with `migrate` can
  // recover the value.
  //
  // `migrate-missing` (#370): distinct tag from `migrate-threw`. No
  // `cause` field — there is no exception to attach, and encoding "no
  // cause" as `cause: undefined` would re-introduce the optional-field
  // state machine the split is meant to retire.
  onError({
    kind: 'migrate-missing',
    key: options.key,
    expectedVersion: options.version,
    storedVersion: parsed.version,
  })
  options.onMigrationFailure?.({
    key: options.key,
    expectedVersion: options.version,
    storedVersion: parsed.version,
  })
  if (!preserveOnError) {
    try {
      options.storage.delete(options.key)
    } catch {
      // ignore
    }
  }
  return initial
}
