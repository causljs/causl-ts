/**
 * Phase 4 #1563 — no serde-wasm-bindgen / serde_json in hot path.
 *
 * Acceptance gate: the shipped `engine_rs_bg.wasm` for the
 * `js-string-builtins` bridge must NOT carry serde-wasm-bindgen
 * import symbols, and a `cargo tree --no-default-features` against
 * the bridge crate must not list `serde-wasm-bindgen` or
 * `serde_json` as transitive dependencies. The hot path uses raw
 * `JsValue` / typed arrays + the intern table from #1562 instead.
 *
 * Expected initial state (today, on `epic/1558-zero-boundary`): the
 * serde-free bridge artefact does not yet exist, and the workspace
 * crate graph still pulls serde-wasm-bindgen for the existing
 * marshaler. The whole block is `describe.todo` so this file does
 * not break `tsc --noEmit` or the `test:run` cascade.
 */

import { describe } from 'vitest'

describe.todo('Phase 4 #1563 — no serde in wasm hot path', () => {
  // 1. The shipped `engine_rs_bg.wasm` for the `js-string-builtins`
  //    bridge does NOT contain any serde-wasm-bindgen import symbols.
  //
  //    Implementation sketch:
  //      const bytes = await readFile(wasmUrlFor('gc-builtins'))
  //      const mod = await WebAssembly.compile(bytes)
  //      const imports = WebAssembly.Module.imports(mod)
  //      const serdeImports = imports.filter(
  //        (i) => /^__wbg.*serde/.test(i.name),
  //      )
  //      expect(serdeImports).toHaveLength(0)
  //
  // 2. A `cargo tree --no-default-features -p engine-rs` invocation
  //    against the bridge crate returns 0 lines containing
  //    `serde-wasm-bindgen` or `serde_json`. Run via `child_process`
  //    and grep the output; skip if `cargo` is unavailable on the
  //    test host (CI provisions it explicitly).
})
