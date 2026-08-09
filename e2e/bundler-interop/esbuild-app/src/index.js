// Fixture entry — same shape as webpack5-app/src/index.js and
// vite5-app/src/index.js. See those for the rationale.

import { createCausl } from '@causlts/core'

const causl = createCausl()
globalThis.__causlHandle = causl

export async function loadWasmLazy() {
  const mod = await import('@causlts/core/wasm')
  return mod
}

globalThis.__causlLoadWasmLazy = loadWasmLazy

export { causl }
