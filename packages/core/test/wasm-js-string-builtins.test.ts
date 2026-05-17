/**
 * Phase 3 #1562 — js-string-builtins bridge artefact contract.
 *
 * Acceptance gate: under the `gc-builtins` bridge artefact the
 * string-heavy hot path must round-trip JS <-> Wasm strings via the
 * spec-defined `string` reference type instead of the legacy
 * `__wbindgen_string_get` / TextDecoder glue, and a content-addressed
 * intern table must dedupe repeated literals.
 *
 * Expected initial state (today, on `epic/1558-zero-boundary`): the
 * `gc-builtins` artefact does not yet exist, the boundary-instrumentation
 * feature counter is not yet wired, and the intern table is not yet
 * implemented. The whole block is therefore `describe.todo` so it does
 * not break `tsc --noEmit` or the `test:run` cascade. When Phase 3
 * lands its artefact + counter the implementer flips `describe.todo`
 * to `describe` and fills in the bodies.
 */

import { describe } from 'vitest'

describe.todo('Phase 3 #1562 — wasm js-string-builtins bridge', () => {
  // 1. Under the `gc-builtins` bridge artefact, a 1000-commit
  //    string-heavy workload produces ZERO `__wbindgen_string_get`
  //    calls. Measured via the boundary-instrumentation feature
  //    counter exposed by the bridge in dev builds.
  //
  // 2. Under the `gc-classic` bridge artefact, the same workload
  //    produces a non-zero `__wbindgen_string_get` count (proof the
  //    legacy fallback path still runs end-to-end).
  //
  // 3. The intern table dedupes by content: writing the literal
  //    "foo" 1000 times produces exactly 1 intern allocation after
  //    the first call (subsequent writes hit the cache).
})
