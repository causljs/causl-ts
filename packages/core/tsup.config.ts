import { defineConfig } from 'tsup'

/**
 * tsup entry config for `@causljs/core`.
 *
 * The map form lets us route `wasm/index.ts` to `dist/wasm.js`
 * without colliding with `src/index.ts → dist/index.js` (tsup's
 * default basename-derived layout would emit both as
 * `dist/index.js`). The exports map in `package.json` mirrors the
 * keys here exactly:
 *
 *   - `./`         → `dist/index.js`     (main barrel — `src/index.ts`)
 *   - `./internal` → `dist/internal.js`  (`src/internal.ts`)
 *   - `./testing`  → `dist/testing.js`   (`src/testing.ts`)
 *   - `./wasm`     → `dist/wasm.js`      (`wasm/index.ts`, lazy-load
 *                                         WASM backend entry point — #684)
 *
 * Adding a new entry: add a key here, mirror it in
 * `package.json#exports`, and (if it ships its own bundle ceiling)
 * register a `size-limit` cell in the root `package.json`.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    internal: 'src/internal.ts',
    testing: 'src/testing.ts',
    wasm: 'wasm/index.ts',
  },
  format: 'esm',
  dts: true,
  clean: true,
  sourcemap: true,
})
