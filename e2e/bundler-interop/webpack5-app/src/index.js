// Fixture entry — exercises both shapes of the @causljs/core import
// surface a real adopter would touch.

import { createCausl } from '@causljs/core'

// Synchronous use of the main barrel. Just constructing the graph is
// enough to keep tree-shaking honest; webpack must not DCE this
// reference, otherwise the gate would silently pass on an empty
// bundle.
const causl = createCausl()
globalThis.__causlHandle = causl

// Lazy / dynamic import of the WASM entry point. This is the seam
// the §14.2 bundle-no-leak invariant defends — the loader stub MUST
// land in a separate chunk, not the main entry.
//
// We DO NOT call `loadWasmBackend()` here. Until #682 / #683 / #693
// land it would throw `WasmBackendUnavailableError` at runtime, but
// that throw is a runtime concern, not a bundler-interop one.
export async function loadWasmLazy() {
  const mod = await import('@causljs/core/wasm')
  return mod
}

// Park the lazy import behind a globally-accessible handle so a
// downstream user (or `verify.mjs`) could exercise it. We don't
// auto-invoke it because the verify step's contract is "the bundle
// builds and the chunk graph is correct" — execution is out of scope.
globalThis.__causlLoadWasmLazy = loadWasmLazy
