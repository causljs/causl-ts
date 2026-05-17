// Fixture entry — same shape as webpack5-app/src/index.js and
// vite5-app/src/index.js. See those for the rationale.

import { createCausl } from '@causljs/core'

const causl = createCausl()
globalThis.__causlHandle = causl

export async function loadWasmLazy() {
  const mod = await import('@causljs/core/wasm')
  return mod
}

globalThis.__causlLoadWasmLazy = loadWasmLazy

export { causl }
