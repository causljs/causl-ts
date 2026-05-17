// webpack 5 bundler-interop fixture (#689).
//
// The gate this fixture defends is "an adopter using webpack 5 can
// bundle @causljs/core and lazy-import @causljs/core/wasm without
// configuration gymnastics beyond `experiments.asyncWebAssembly`".
//
// What we exercise:
//   - Production mode + ESM output (mode: 'production', target: 'web').
//   - `experiments.asyncWebAssembly: true` — required by the
//     `new URL('./pkg/...', import.meta.url)` pattern in
//     packages/core/wasm/index.ts for `.wasm` asset rewriting.
//   - Code splitting on dynamic `import('@causljs/core/wasm')` — the
//     loader stub MUST land in a separate chunk, not the main entry.
//
// Output goes to `./dist/`. CI's `verify.mjs` step asserts:
//   - `dist/main.*.js` does NOT contain `loadWasmBackend` or
//     `WasmBackendUnavailableError` (proves the lazy split worked).
//   - A separate chunk exists that DOES contain those sentinels.
//
// The chunk-naming pattern uses `[name].[contenthash:8].js` so the
// verify script can find the main bundle deterministically while
// keeping content hashes for cache-busting realism.

const path = require('node:path')

/** @type {import('webpack').Configuration} */
module.exports = {
  mode: 'production',
  target: 'web',
  entry: './src/index.js',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].[contenthash:8].js',
    chunkFilename: 'chunk.[name].[contenthash:8].js',
    clean: true,
  },
  experiments: {
    asyncWebAssembly: true,
    outputModule: false,
  },
  // Default optimisation already splits dynamic imports into their
  // own chunk; we don't override it here.
  resolve: {
    extensions: ['.js', '.mjs'],
  },
}
