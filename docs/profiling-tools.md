# Profiling tools

> Three profilers cover the shapes of perf work the bench package
> does. Pick by what you need to share or grep.

## The toolkit

- **`0x`** — flame-graph generator. Emits a self-contained SVG small
  enough to commit alongside a perf-investigation PR. Shipped as the
  root `devDependency` `0x@^6.0.0`; wired as
  `pnpm --filter @causl/bench profile:flame` (which shells out to
  `npx --yes 0x@5` to pin the wrapper independently of the resolved
  devDependency major). The repo-wide `pnpm bench:profile` driver
  uses `require.resolve('0x')` against the root install. Use when
  you want the CPU picture as a reviewable artefact.
- **`node --cpu-prof`** — built-in V8 sampler. Drops a `*.cpuprofile`
  JSON that loads in [speedscope](https://www.speedscope.app/) and is
  greppable on disk (function names are plain strings). Use to diff two
  runs or to script extraction of hot frames.
- **`node --heap-prof`** — built-in V8 heap sampler. Drops a
  `*.heapprofile` for allocation hotspots — the right tool for the
  cell-allocation work this package keeps poking at. Wired as
  `pnpm --filter @causl/bench profile:heap` (there is no top-level
  `bench:profile:heap` alias; the bench-cell driver is single-cell,
  not the multi-library `bench:profile*` driver pair).

Profiles land in `packages/bench/report/profiles/` (created by the
bench `prebuild` script) and are gitignored unless you commit a flame
SVG with a write-up.

## Why not clinic?

`clinic doctor` assumes a long-lived HTTP server with request
lifecycles. Our bench scripts are short-lived `tsx` drivers, so
doctor's event-loop and active-handle diagnostics come back blank.
`0x` — which clinic-flame already wraps — gives us the flame output
without the unused server machinery.
