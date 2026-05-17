/**
 * Ambient `process` declaration for the bundler-replacement
 * `process.env.NODE_ENV` literal gate (#1241 fix C). `@causljs/core`'s
 * tsconfig does not include `@types/node` so the type-checker
 * cannot resolve `process` from the Node global; this minimal
 * declaration is the smallest patch that makes the literal
 * expression typecheck.
 *
 * The access is the bare `process.env.NODE_ENV` shape because
 * esbuild / terser / webpack substitute the literal string
 * `'production'` for it at build time (the `DefinePlugin` /
 * `--define:process.env.NODE_ENV='"production"'` conventions every
 * major JS bundler honours) iff the access is exactly that shape;
 * any indirection (`globalThis.process`, `import.meta.env`, …)
 * defeats the substitution.
 */
declare const process: { env: { NODE_ENV?: string } }

/**
 * #1241 / #1549 Part B — THE single source of truth for the
 * NODE_ENV production gate across `@causljs/core`. `process.env` is
 * read EXACTLY ONCE here, at module load, and the resulting boolean
 * is imported everywhere else. Nothing else in the engine may read
 * `process.env.NODE_ENV` directly — import this const instead.
 *
 * Why one cached read rather than the bare literal at each use site
 * (the pre-#1549 form):
 *
 * - **Hot-path cost (#1549 Part B).** `process.env` is a Node host
 *   object backed by a C++ environment lookup; each
 *   `process.env.NODE_ENV` access is ~100× a normal property read
 *   and is not JIT-inlinable. The gate sits in `read()` — the
 *   single hottest primitive — so the bare per-read access was
 *   measured at ~93 ns/read, ~95% of `op-read-cold`'s total and the
 *   dominant cause of that benchmark's deficit vs redux. It is paid
 *   in production too (the condition evaluates either way) and by
 *   every consumer that does not bundle `@causljs/core` through a prod
 *   `define` (SSR / Node services / scripts / tests / benchmarks).
 *   Reading `process.env` once at module load removes the cost from
 *   every gated site with zero behaviour change.
 *
 * - **Bundler DCE is preserved.** A bundler `define` substitutes
 *   `process.env.NODE_ENV` at this single site → `'production' ===
 *   'production'` → esbuild/terser constant-fold to
 *   `NODE_ENV_IS_PRODUCTION = true` and then cross-module
 *   const-propagate that literal into every `if (!…)` / `if (…)`
 *   use → `if (false)` / `if (true)` → the H1 WeakRef apparatus
 *   (and its helper closures) is still tree-shaken out of prod
 *   bundles exactly as #1241 fix C intended.
 *
 * Semantics: the gate is snapshotted at import, matching the
 * universal `const __DEV__ = process.env.NODE_ENV !== 'production'`
 * idiom (React/Redux/etc.) and #1241's own build-time-constant
 * model. Mutating `process.env.NODE_ENV` AFTER import does not
 * retro-arm the H1 tracker — that was never a supported runtime
 * knob (`enableH1HazardWarning` is the per-engine opt-in). Tests
 * that need the production path must establish it before importing
 * the engine (e.g. `vi.resetModules()` + dynamic import).
 *
 * IMPORTANT for future maintainers: do NOT re-introduce a per-site
 * `process.env.NODE_ENV` literal "for bundler DCE" — the
 * const-of-literal form here already preserves DCE (via standard
 * const propagation) AND fixes the #1549 Part B hot-path cost.
 * Re-inlining reintroduces ~93 ns on every `read()`.
 */
export const NODE_ENV_IS_PRODUCTION =
  process.env.NODE_ENV === 'production'
