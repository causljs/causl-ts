// Vite 5 bundler-interop fixture (#689).
//
// `build.lib` mode emits an ESM library bundle so we can grep the
// chunk text in verify.mjs without HTML/index-template noise. This
// mirrors the shape an adopter shipping a library on top of
// @causl/core would produce (the broader test case — Vite app mode —
// has the same code-split rules underneath, so this is the right
// proxy).
//
// The `manualChunks` knob is left at the default. Vite 5 (via
// Rollup 4) automatically splits dynamic imports into their own
// chunk; we assert that in verify.mjs.

import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'es2022',
    minify: false,
    lib: {
      entry: './src/index.js',
      formats: ['es'],
      fileName: () => 'main.js',
    },
    rollupOptions: {
      // No externals — we want @causl/core fully bundled so the
      // grep-the-output gate has something to grep.
      //
      // `build.lib` defaults `preserveEntrySignatures` to 'strict',
      // which makes Rollup emit `main.js` as a thin re-export *facade*
      // and hoist the entry's own code (including the
      // `globalThis.__causlHandle = …` assignment the verify gate
      // anchors on) into a separate `chunk.index.*.js`. Setting it to
      // `false` lets Rollup inline the entry module directly into
      // `main.js` so the gate's "entry not tree-shaken to a no-op"
      // check sees `__causlHandle` in the main chunk. The dynamic
      // `import('@causl/core/wasm')` is unaffected — dynamic imports
      // still split into their own chunk regardless of this knob.
      preserveEntrySignatures: false,
      output: {
        chunkFileNames: 'chunk.[name].[hash].js',
        entryFileNames: 'main.js',
      },
    },
    outDir: 'dist',
    emptyOutDir: true,
  },
})
