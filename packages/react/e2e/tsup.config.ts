/**
 * tsup config for the 1000-cell cross-library viewport fixture (#869,
 * extending the causl-only #765 / PR #800 gate).
 *
 * The default `tsup` invocation (the one that builds `dist/index.js`)
 * marks every workspace dep + every peerDep as external. That is the
 * right call for a published package — consumers bring their own
 * React. For the e2e harness it is the wrong call: the bundle has to
 * be a self-contained browser ESM module the static fixture page can
 * import directly with no node_modules resolver, no importmap, no
 * UMD shim. So this config flips `noExternal` to bake everything
 * in: `@causljs/core`, `@causljs/react`, `react`, `react-dom`, plus the
 * three comparison libraries the cross-library gate exercises
 * (`jotai`, `@reduxjs/toolkit` + `react-redux` + `redux`, `mobx` +
 * `mobx-react-lite`).
 */
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['e2e/fixtures/viewport-1000.tsx'],
  outDir: 'e2e/fixtures',
  format: ['esm'],
  target: 'es2022',
  splitting: false,
  minify: true,
  sourcemap: false,
  clean: false,
  noExternal: [
    '@causljs/core',
    '@causljs/core/internal',
    '@causljs/react',
    'react',
    'react-dom',
    'react-dom/client',
    'react/jsx-runtime',
    'jotai',
    '@reduxjs/toolkit',
    'react-redux',
    'redux',
    'mobx',
    'mobx-react-lite',
    'use-sync-external-store',
  ],
  // Set NODE_ENV=production so React's UMD-prod branch wins inside
  // the bundle. Dev React is ~3x slower and would let a regression
  // hide behind dev-only overhead. The same flag also unlocks
  // production paths in react-redux / mobx-react-lite (dev-only
  // warnings stripped, production-mode `useSyncExternalStore`
  // shim picked).
  define: {
    'process.env.NODE_ENV': '"production"',
  },
})
