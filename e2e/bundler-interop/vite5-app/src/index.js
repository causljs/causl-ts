// Fixture entry — same shape as webpack5-app/src/index.js, exercises
// both the main barrel and the lazy WASM entry point. Comments
// abbreviated; see webpack5-app/src/index.js for the rationale.

import { createCausl } from '@causlts/core'

const causl = createCausl()
globalThis.__causlHandle = causl

export async function loadWasmLazy() {
  const mod = await import('@causlts/core/wasm')
  return mod
}

globalThis.__causlLoadWasmLazy = loadWasmLazy

export { causl }
