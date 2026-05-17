/**
 * Phase 5 #1564 — BridgeId narrowed after serde retirement.
 *
 * Acceptance gate: once the serde-wasm-bindgen bridge artefact is
 * retired (#1563 + #1564), the exported `BridgeId` type union must
 * drop `'serde-json'` and only carry the two surviving artefact ids
 * (`'wasmgc-builtins'`, `'wasmgc-classic'`) plus the open
 * `(string & {})` escape hatch for forward-compat. At runtime,
 * `wasmUrlFor('serde-json')` must throw a stable structured error so
 * downstream consumers that hard-coded the legacy id fail loudly
 * instead of silently 404-ing on a missing artefact.
 *
 * Expected initial state (today): the current `BridgeId` union and
 * `wasmUrlFor()` still accept the legacy id, the
 * `BridgeIdUnknownError` class does not yet exist, and the
 * `Expect<Equal<...>>` brand helper isn't wired up either. The whole
 * block is `describe.todo` so this file doesn't break `tsc --noEmit`
 * or the `test:run` cascade.
 */

import { describe } from 'vitest'

describe.todo('Phase 5 #1564 — BridgeId narrowed', () => {
  // 1. The `BridgeId` type union excludes `'serde-json'`. Pinned at
  //    the TypeScript level via a brand-pattern equality check:
  //
  //      type Equal<X, Y> =
  //        (<T>() => T extends X ? 1 : 2) extends
  //        (<T>() => T extends Y ? 1 : 2) ? true : false
  //      type Expect<T extends true> = T
  //      type _Pin = Expect<
  //        Equal<BridgeId, 'wasmgc-builtins' | 'wasmgc-classic' | (string & {})>
  //      >
  //
  //    Compilation failure IS the assertion; the runtime body can be
  //    a trivial `expect(true).toBe(true)`.
  //
  // 2. Runtime: `wasmUrlFor('serde-json')` throws `BridgeIdUnknownError`
  //    (or whatever the structured error class lands as — the exact
  //    name isn't fully pinned yet). Implementation:
  //
  //      expect(() => wasmUrlFor('serde-json' as BridgeId)).toThrow(
  //        BridgeIdUnknownError,
  //      )
})
